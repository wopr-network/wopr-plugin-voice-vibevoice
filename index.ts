/**
 * WOPR Voice Plugin: VibeVoice TTS
 *
 * Connects to VibeVoice TTS server via HTTP API.
 * Supports multiple voices and high-quality speech synthesis.
 *
 * Docker: valyriantech/vibevoice_server
 */

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

interface WOPRPlugin {
	name: string;
	version: string;
	description?: string;
	manifest?: Record<string, unknown>;
	init?: (ctx: WOPRPluginContext) => Promise<void>;
	shutdown?: () => Promise<void>;
}

interface WOPRPluginContext {
	log: {
		info: (msg: string) => void;
		error: (msg: string) => void;
		warn: (msg: string) => void;
		debug: (msg: string) => void;
	};
	getConfig: <T>() => T;
	registerExtension: (type: string, provider: unknown) => void;
	unregisterExtension: (name: string) => void;
	registerConfigSchema: (pluginId: string, schema: unknown) => void;
	unregisterConfigSchema: (pluginId: string) => void;
	registerCapabilityProvider?: (
		type: string,
		descriptor: { id: string; name: string },
	) => void;
}

interface VibeVoiceConfig {
	serverUrl?: string;
	voice?: string;
	speed?: number;
}

const DEFAULT_CONFIG: Required<VibeVoiceConfig> = {
	serverUrl: process.env.VIBEVOICE_URL || "http://vibevoice-tts:8881",
	voice: process.env.VIBEVOICE_VOICE || "default",
	speed: parseFloat(process.env.VIBEVOICE_SPEED || "1.0"),
};

function parseWavSampleRate(buffer: Buffer): number {
	if (buffer.length < 28) return 24000;
	if (buffer.toString("ascii", 0, 4) !== "RIFF") return 24000;
	return buffer.readUInt32LE(24);
}

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
		description: "Microsoft VibeVoice TTS",
		capabilities: ["voice-selection", "speed-control", "voice-cloning"],
		local: true,
		emoji: "🎤",
	};

	readonly voices: Voice[] = [
		{ id: "default", name: "Default", language: "en", gender: "neutral" },
	];

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

	async fetchVoices(): Promise<void> {
		try {
			const response = await fetch(`${this.config.serverUrl}/v1/voices`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (response.ok) {
				// Pre-warm: voices fetched successfully
			}
		} catch {
			// Voice fetch failed, use defaults
		}
	}

	async synthesize(
		text: string,
		options?: TTSOptions,
	): Promise<TTSSynthesisResult> {
		const startTime = Date.now();
		const voice = options?.voice || this.config.voice;
		const speed = options?.speed || this.config.speed;

		const params = new URLSearchParams({
			text,
			speed: speed.toString(),
		});

		if (voice && voice !== "default") {
			params.set("voice", voice);
			const response = await fetch(
				`${this.config.serverUrl}/synthesize_speech/?${params}`,
				{
					method: "GET",
					signal: AbortSignal.timeout(60000),
				},
			);

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`VibeVoice TTS error: ${response.status} - ${error}`);
			}

			const arrayBuffer = await response.arrayBuffer();
			const wavBuffer = Buffer.from(arrayBuffer);
			const { pcm, sampleRate } = wavToPcm(wavBuffer);

			return {
				audio: pcm,
				format: "pcm_s16le",
				sampleRate,
				durationMs: Date.now() - startTime,
			};
		}

		const response = await fetch(
			`${this.config.serverUrl}/base_tts/?${params}`,
			{
				method: "GET",
				signal: AbortSignal.timeout(60000),
			},
		);

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`VibeVoice TTS error: ${response.status} - ${error}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		const wavBuffer = Buffer.from(arrayBuffer);

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
			const response = await fetch(
				`${this.config.serverUrl}/base_tts/?text=test`,
				{
					method: "GET",
					signal: AbortSignal.timeout(5000),
				},
			);
			return response.status !== 404;
		} catch {
			return false;
		}
	}

	async shutdown(): Promise<void> {
		// No cleanup needed
	}
}

let provider: VibeVoiceProvider | null = null;
let _ctx: WOPRPluginContext | null = null;

const CONFIG_SCHEMA = {
	title: "VibeVoice TTS",
	description: "Self-hosted Microsoft VibeVoice TTS server",
	fields: [
		{
			name: "serverUrl",
			type: "text" as const,
			label: "Server URL",
			placeholder: "http://vibevoice-tts:8881",
			description: "URL of the VibeVoice TTS server",
			default: "http://vibevoice-tts:8881",
		},
		{
			name: "voice",
			type: "text" as const,
			label: "Default Voice",
			placeholder: "default",
			description: "Default voice name for synthesis",
			default: "default",
		},
		{
			name: "speed",
			type: "number" as const,
			label: "Speed",
			description: "Speech speed multiplier (0.5 - 2.0)",
			default: 1.0,
		},
	],
};

const plugin: WOPRPlugin = {
	name: "voice-vibevoice",
	version: "1.0.0",
	description: "Microsoft VibeVoice TTS",

	manifest: {
		name: "wopr-plugin-voice-vibevoice",
		version: "1.0.0",
		description: "Microsoft VibeVoice TTS (self-hosted, Docker)",
		capabilities: ["tts"],
		category: "voice",
		tags: ["tts", "voice", "vibevoice", "local", "docker", "self-hosted"],
		icon: "🎤",
		requires: {
			docker: ["valyriantech/vibevoice_server:latest"],
		},
		provides: {
			capabilities: [
				{
					type: "tts",
					id: "vibevoice",
					displayName: "VibeVoice TTS",
					tier: "wopr" as const,
				},
			],
		},
		lifecycle: {
			shutdownBehavior: "graceful" as const,
		},
		configSchema: CONFIG_SCHEMA,
		install: [
			{
				kind: "docker" as const,
				image: "valyriantech/vibevoice_server",
				tag: "latest",
				label: "Pull VibeVoice server",
			},
		],
	},

	async init(ctx: WOPRPluginContext) {
		_ctx = ctx;
		const config = ctx.getConfig<VibeVoiceConfig>();
		provider = new VibeVoiceProvider(config);

		try {
			provider.validateConfig();
			const healthy = await provider.healthCheck();
			if (healthy) {
				await provider.fetchVoices();
				ctx.registerExtension("tts", provider);
				if (typeof ctx.registerCapabilityProvider === "function") {
					ctx.registerCapabilityProvider("tts", {
						id: provider.metadata.name,
						name: provider.metadata.description || provider.metadata.name,
					});
				}
				ctx.registerConfigSchema("voice-vibevoice", CONFIG_SCHEMA);
				ctx.log.info(`VibeVoice TTS registered (${provider.serverUrl})`);
			} else {
				ctx.log.warn(`VibeVoice server not reachable at ${provider.serverUrl}`);
			}
		} catch (err: unknown) {
			ctx.log.error(`Failed to init VibeVoice TTS: ${err}`);
		}
	},

	async shutdown() {
		if (_ctx) {
			try {
				_ctx.unregisterExtension("tts");
			} catch {
				// Extension may not have been registered
			}
			try {
				_ctx.unregisterConfigSchema("voice-vibevoice");
			} catch {
				// Schema may not have been registered
			}
			_ctx = null;
		}
		if (provider) {
			await provider.shutdown();
			provider = null;
		}
	},
};

export default plugin;
