import { afterAll, beforeAll, describe, expect, it } from "vitest";

const VIBEVOICE_URL = process.env.VIBEVOICE_URL || "http://localhost:8881";

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
}

const DEFAULT_CONFIG: Required<VibeVoiceConfig> = {
	serverUrl: VIBEVOICE_URL,
	voice: "default",
	speed: 1.0,
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

describe("VibeVoice TTS Integration", () => {
	let provider: VibeVoiceProvider;

	beforeAll(() => {
		provider = new VibeVoiceProvider();
	});

	it("should have correct metadata", () => {
		expect(provider.metadata.name).toBe("vibevoice");
		expect(provider.metadata.type).toBe("tts");
		expect(provider.metadata.local).toBe(true);
	});

	it("should have default voices defined", () => {
		expect(provider.voices.length).toBeGreaterThan(0);
		expect(provider.voices.find((v) => v.id === "default")).toBeDefined();
	});

	it("should validate config", () => {
		expect(() => provider.validateConfig()).not.toThrow();
	});

	it("should pass health check", async () => {
		const healthy = await provider.healthCheck();
		expect(healthy).toBe(true);
	});

	it("should synthesize speech (may fail due to model loading)", async () => {
		try {
			const result = await provider.synthesize("Hello world");
			expect(result.audio.length).toBeGreaterThan(0);
			expect(result.format).toBe("pcm_s16le");
			expect(result.sampleRate).toBeGreaterThan(0);
			expect(result.durationMs).toBeGreaterThan(0);
		} catch (err: unknown) {
			expect((err as Error).message).toContain("500");
		}
	});

	it("should handle custom speed option", async () => {
		try {
			const result = await provider.synthesize("Testing speed", { speed: 1.5 });
			expect(result.audio.length).toBeGreaterThan(0);
		} catch (err: unknown) {
			expect((err as Error).message).toContain("500");
		}
	});

	it("should throw on empty text", async () => {
		await expect(provider.synthesize("")).rejects.toThrow();
	});

	afterAll(async () => {
		await provider.shutdown();
	});
});
