/**
 * WOPR Voice Plugin: VibeVoice TTS
 *
 * Connects to VibeVoice TTS server via OpenAI-compatible HTTP API.
 * Supports voice selection, speed control, and voice cloning.
 *
 * Docker: marhensa/vibevoice-realtime-openai-api
 */

import type { WOPRPlugin, WOPRPluginContext } from "@wopr-network/plugin-types";

interface TTSSynthesisResult {
	audio: Buffer;
	format: "pcm_s16le" | "mp3" | "wav" | "opus";
	sampleRate: number;
	durationMs: number;
}

interface TTSOptions {
	voice?: string;
	speed?: number;
	sampleRate?: number;
}

interface Voice {
	id: string;
	name: string;
	language?: string;
	gender?: "male" | "female" | "neutral";
	description?: string;
}

interface VoicePluginMetadata {
	name: string;
	version: string;
	type: "stt" | "tts";
	description: string;
	capabilities?: string[];
	local?: boolean;
	emoji?: string;
}

interface TTSProvider {
	readonly metadata: VoicePluginMetadata;
	readonly voices: Voice[];
	synthesize(text: string, options?: TTSOptions): Promise<TTSSynthesisResult>;
	healthCheck?(): Promise<boolean>;
	shutdown?(): Promise<void>;
	validateConfig(): void;
}

// VibeVoice-specific config
interface VibeVoiceConfig {
	/** Server URL (e.g., http://vibevoice-tts:8080) */
	serverUrl?: string;
	/** Default voice name */
	voice?: string;
	/** Speed multiplier (0.8-1.2) */
	speed?: number;
	/** CFG scale (0.0-3.0) - controls expressiveness */
	cfgScale?: number;
	/** Response format from server */
	responseFormat?: "wav" | "mp3" | "opus" | "flac" | "pcm";
}

const DEFAULT_CONFIG: Required<VibeVoiceConfig> = {
	serverUrl: process.env.VIBEVOICE_URL || "http://vibevoice-tts:8080",
	voice: process.env.VIBEVOICE_VOICE || "alloy",
	speed: 1.0,
	cfgScale: 1.25,
	responseFormat: "wav",
};

// Built-in voices for the OpenAI-compatible VibeVoice server
const BUILTIN_VOICES: Voice[] = [
	{ id: "alloy", name: "Alloy (Carter)", language: "en", gender: "male" },
	{ id: "echo", name: "Echo (Davis)", language: "en", gender: "male" },
	{ id: "fable", name: "Fable (Emma)", language: "en", gender: "female" },
	{ id: "onyx", name: "Onyx (Frank)", language: "en", gender: "male" },
	{ id: "nova", name: "Nova (Grace)", language: "en", gender: "female" },
	{ id: "shimmer", name: "Shimmer (Mike)", language: "en", gender: "male" },
	{ id: "samuel", name: "Samuel", language: "en", gender: "male" },
];

/**
 * Parse WAV header to extract sample rate
 */
function parseWavSampleRate(buffer: Buffer): number {
	if (buffer.length < 28) return 24000;
	if (buffer.toString("ascii", 0, 4) !== "RIFF") return 24000;
	return buffer.readUInt32LE(24);
}

/**
 * Extract PCM data from WAV buffer
 */
function wavToPcm(wavBuffer: Buffer): { pcm: Buffer; sampleRate: number } {
	let offset = 12;
	let sampleRate = 24000;

	while (offset < wavBuffer.length - 8) {
		const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
		const chunkSize = wavBuffer.readUInt32LE(offset + 4);

		if (chunkId === "fmt ") {
			sampleRate = wavBuffer.readUInt32LE(offset + 12);
		} else if (chunkId === "data") {
			const pcm = wavBuffer.subarray(offset + 8, offset + 8 + chunkSize);
			return { pcm, sampleRate };
		}

		offset += 8 + chunkSize;
	}

	return {
		pcm: wavBuffer.subarray(44),
		sampleRate: parseWavSampleRate(wavBuffer),
	};
}

class VibeVoiceProvider implements TTSProvider {
	readonly metadata: VoicePluginMetadata = {
		name: "vibevoice",
		version: "1.0.0",
		type: "tts",
		description: "High-quality TTS via Microsoft VibeVoice (OpenAI-compatible)",
		capabilities: ["voice-selection", "speed-control", "voice-cloning"],
		local: true,
		emoji: "🎙️",
	};

	readonly voices: Voice[] = [...BUILTIN_VOICES];

	private config: Required<VibeVoiceConfig>;

	constructor(config: VibeVoiceConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	get serverUrl(): string {
		return this.config.serverUrl;
	}

	validateConfig(): void {
		if (!this.config.serverUrl) {
			throw new Error("serverUrl is required");
		}
	}

	async synthesize(
		text: string,
		options?: TTSOptions,
	): Promise<TTSSynthesisResult> {
		const startTime = Date.now();
		const voice = options?.voice || this.config.voice;
		const speed = options?.speed || this.config.speed;

		const requestBody = {
			input: text,
			voice: voice,
			model: "tts-1-hd",
			response_format: this.config.responseFormat,
			speed: speed,
			cfg_scale: this.config.cfgScale,
		};

		const response = await fetch(`${this.config.serverUrl}/v1/audio/speech`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(requestBody),
			signal: AbortSignal.timeout(60000),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`VibeVoice TTS error: ${response.status} - ${error}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		const wavBuffer = Buffer.from(arrayBuffer);

		// Extract PCM from WAV
		const { pcm, sampleRate } = wavToPcm(wavBuffer);

		return {
			audio: pcm,
			format: "pcm_s16le",
			sampleRate,
			durationMs: Date.now() - startTime,
		};
	}

	async healthCheck(): Promise<boolean> {
		try {
			const response = await fetch(`${this.config.serverUrl}/health`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});
			return response.ok;
		} catch (_err: unknown) {
			try {
				const response = await fetch(this.config.serverUrl, {
					method: "GET",
					signal: AbortSignal.timeout(5000),
				});
				return response.status !== 404;
			} catch (_err: unknown) {
				return false;
			}
		}
	}

	async shutdown(): Promise<void> {
		// No cleanup needed
	}
}

let pluginCtx: WOPRPluginContext | null = null;
let provider: VibeVoiceProvider | null = null;
const cleanups: Array<() => void> = [];

const plugin: WOPRPlugin = {
	manifest: {
		name: "voice-vibevoice",
		version: "1.0.0",
		description: "High-quality TTS via Microsoft VibeVoice (OpenAI-compatible)",
		capabilities: ["tts"],
	},
	name: "voice-vibevoice",
	version: "1.0.0",
	description: "High-quality TTS via Microsoft VibeVoice",

	async init(ctx: WOPRPluginContext) {
		pluginCtx = ctx;
		const config = ctx.getConfig<VibeVoiceConfig>();
		provider = new VibeVoiceProvider(config);

		ctx.registerConfigSchema("voice-vibevoice", {
			title: "VibeVoice TTS Configuration",
			description: "Configure the VibeVoice TTS server connection",
			fields: [
				{
					name: "serverUrl",
					type: "text",
					label: "Server URL",
					placeholder: "http://vibevoice-tts:8080",
					default: "http://vibevoice-tts:8080",
					description: "URL of your VibeVoice server",
				},
				{
					name: "voice",
					type: "text",
					label: "Default Voice",
					placeholder: "alloy",
					default: "alloy",
					description:
						"Default voice ID (e.g. alloy, echo, fable, onyx, nova, shimmer)",
				},
				{
					name: "speed",
					type: "text",
					label: "Speed",
					placeholder: "1.0",
					default: "1.0",
					description: "Playback speed multiplier (0.8-1.2)",
				},
			],
		});
		cleanups.push(() => pluginCtx?.unregisterConfigSchema("voice-vibevoice"));

		try {
			provider.validateConfig();
			const healthy = await provider.healthCheck();
			if (healthy) {
				ctx.registerExtension("tts", provider);
				cleanups.push(() => pluginCtx?.unregisterExtension("tts"));
				ctx.registerCapabilityProvider("tts", {
					id: provider.metadata.name,
					name: provider.metadata.description || provider.metadata.name,
				});
				ctx.log.info(`VibeVoice TTS registered (${provider.serverUrl})`);
			} else {
				ctx.log.warn(`VibeVoice server not reachable at ${provider.serverUrl}`);
			}
		} catch (err: unknown) {
			ctx.log.error(`Failed to init VibeVoice TTS: ${err}`);
		}
	},

	async shutdown() {
		for (const cleanup of cleanups.reverse()) {
			try {
				cleanup();
			} catch (_err: unknown) {
				// Ignore cleanup errors during shutdown
			}
		}
		cleanups.length = 0;
		if (provider) {
			await provider.shutdown();
			provider = null;
		}
		pluginCtx = null;
	},
};

export default plugin;
