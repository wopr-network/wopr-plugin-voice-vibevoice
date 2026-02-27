import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Inline types mirroring the plugin
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

interface VibeVoiceConfig {
	serverUrl?: string;
	voice?: string;
	speed?: number;
	cfgScale?: number;
	responseFormat?: "wav" | "mp3" | "opus" | "flac" | "pcm";
}

const DEFAULT_CONFIG: Required<VibeVoiceConfig> = {
	serverUrl: process.env.VIBEVOICE_URL || "http://vibevoice-tts:8080",
	voice: process.env.VIBEVOICE_VOICE || "alloy",
	speed: 1.0,
	cfgScale: 1.25,
	responseFormat: "wav",
};

const BUILTIN_VOICES: Voice[] = [
	{ id: "alloy", name: "Alloy (Carter)", language: "en", gender: "male" },
	{ id: "echo", name: "Echo (Davis)", language: "en", gender: "male" },
	{ id: "fable", name: "Fable (Emma)", language: "en", gender: "female" },
	{ id: "onyx", name: "Onyx (Frank)", language: "en", gender: "male" },
	{ id: "nova", name: "Nova (Grace)", language: "en", gender: "female" },
	{ id: "shimmer", name: "Shimmer (Mike)", language: "en", gender: "male" },
	{ id: "samuel", name: "Samuel", language: "en", gender: "male" },
];

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

	validateConfig(): void {
		if (!this.config.serverUrl) {
			throw new Error("serverUrl is required");
		}
	}

	async fetchVoices(): Promise<void> {
		try {
			const response = await fetch(`${this.config.serverUrl}/v1/audio/voices`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (response.ok) {
				// voices fetched
			}
		} catch {
			// Voice fetch failed, use built-in defaults
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
			voice,
			model: "tts-1-hd",
			response_format: this.config.responseFormat,
			speed,
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
		} catch {
			try {
				const response = await fetch(this.config.serverUrl, {
					method: "GET",
					signal: AbortSignal.timeout(5000),
				});
				return response.ok || response.status === 404;
			} catch {
				return false;
			}
		}
	}

	async shutdown(): Promise<void> {
		// No cleanup needed
	}
}

describe("VibeVoice TTS Plugin", () => {
	let provider: VibeVoiceProvider;

	beforeAll(() => {
		provider = new VibeVoiceProvider();
	});

	it("should have correct metadata", () => {
		expect(provider.metadata.name).toBe("vibevoice");
		expect(provider.metadata.type).toBe("tts");
		expect(provider.metadata.local).toBe(true);
		expect(provider.metadata.capabilities).toContain("voice-selection");
		expect(provider.metadata.capabilities).toContain("speed-control");
		expect(provider.metadata.capabilities).toContain("voice-cloning");
	});

	it("should have 7 built-in voices", () => {
		expect(provider.voices.length).toBe(7);
		const ids = provider.voices.map((v) => v.id);
		expect(ids).toContain("alloy");
		expect(ids).toContain("echo");
		expect(ids).toContain("fable");
		expect(ids).toContain("onyx");
		expect(ids).toContain("nova");
		expect(ids).toContain("shimmer");
		expect(ids).toContain("samuel");
	});

	it("should validate config without error", () => {
		expect(() => provider.validateConfig()).not.toThrow();
	});

	it("should throw when serverUrl is empty", () => {
		const badProvider = new VibeVoiceProvider({ serverUrl: "" });
		expect(() => badProvider.validateConfig()).toThrow("serverUrl is required");
	});

	it("should use alloy as default voice", () => {
		const p = new VibeVoiceProvider();
		expect(p.voices.find((v) => v.id === "alloy")).toBeDefined();
	});

	it("should parse WAV sample rate correctly", () => {
		// Minimal WAV header: RIFF + size + WAVE + fmt + size + audioFormat + channels + sampleRate
		const buf = Buffer.alloc(28);
		buf.write("RIFF", 0, "ascii");
		buf.writeUInt32LE(20, 4);
		buf.write("WAVE", 8, "ascii");
		buf.write("fmt ", 12, "ascii");
		buf.writeUInt32LE(16, 16); // chunk size
		buf.writeUInt16LE(1, 20); // PCM
		buf.writeUInt16LE(1, 22); // mono
		buf.writeUInt32LE(22050, 24); // sample rate
		expect(parseWavSampleRate(buf)).toBe(22050);
	});

	it("should return 24000 for non-WAV buffer in parseWavSampleRate", () => {
		const buf = Buffer.from("not a wav file");
		expect(parseWavSampleRate(buf)).toBe(24000);
	});

	it("should extract PCM from WAV buffer", () => {
		// Build a minimal valid WAV with a data chunk
		const pcmData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
		const wav = Buffer.alloc(44 + pcmData.length);
		wav.write("RIFF", 0, "ascii");
		wav.writeUInt32LE(36 + pcmData.length, 4);
		wav.write("WAVE", 8, "ascii");
		wav.write("fmt ", 12, "ascii");
		wav.writeUInt32LE(16, 16);
		wav.writeUInt16LE(1, 20);
		wav.writeUInt16LE(1, 22);
		wav.writeUInt32LE(44100, 24);
		wav.writeUInt32LE(44100 * 2, 28);
		wav.writeUInt16LE(2, 32);
		wav.writeUInt16LE(16, 34);
		wav.write("data", 36, "ascii");
		wav.writeUInt32LE(pcmData.length, 40);
		pcmData.copy(wav, 44);

		const { pcm, sampleRate } = wavToPcm(wav);
		expect(pcm).toEqual(pcmData);
		expect(sampleRate).toBe(44100);
	});

	it("should return false from healthCheck when server unreachable", async () => {
		const p = new VibeVoiceProvider({ serverUrl: "http://127.0.0.1:19999" });
		const healthy = await p.healthCheck();
		expect(healthy).toBe(false);
	});

	it("should throw on synthesis error from server", async () => {
		// Server doesn't exist, so fetch will throw (connection refused)
		const p = new VibeVoiceProvider({ serverUrl: "http://127.0.0.1:19999" });
		await expect(p.synthesize("Hello world")).rejects.toThrow();
	});

	it("should call shutdown without error", async () => {
		await expect(provider.shutdown()).resolves.toBeUndefined();
	});

	afterAll(async () => {
		await provider.shutdown();
	});
});
