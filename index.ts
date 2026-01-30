/**
 * WOPR Voice Plugin: Chatterbox TTS
 *
 * Connects to Chatterbox TTS server via OpenAI-compatible HTTP API.
 * Supports voice cloning and high-quality speech synthesis.
 *
 * Docker: travisvn/chatterbox-tts-api or devnen/chatterbox-tts-server
 */

// Inline types from WOPR
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
  registerTTSProvider: (provider: TTSProvider) => void;
}

interface ChatterboxConfig {
  /** Server URL (e.g., http://chatterbox-tts:8000) */
  serverUrl?: string;
  /** Default voice name */
  voice?: string;
  /** Exaggeration level (0.0-1.0) - controls expressiveness */
  exaggeration?: number;
  /** CFG weight (0.0-1.0) - controls adherence to voice characteristics */
  cfgWeight?: number;
  /** Temperature (0.0-1.0) - controls randomness */
  temperature?: number;
}

const DEFAULT_CONFIG: Required<ChatterboxConfig> = {
  serverUrl: process.env.CHATTERBOX_URL || "http://chatterbox-tts:5123",
  voice: process.env.CHATTERBOX_VOICE || "default",
  exaggeration: 0.5,
  cfgWeight: 0.5,
  temperature: 0.8,
};

/**
 * Parse WAV header to extract sample rate
 */
function parseWavSampleRate(buffer: Buffer): number {
  // WAV header: bytes 24-27 contain sample rate (little-endian)
  if (buffer.length < 28) return 24000; // Default fallback
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return 24000;
  return buffer.readUInt32LE(24);
}

/**
 * Extract PCM data from WAV buffer
 */
function wavToPcm(wavBuffer: Buffer): { pcm: Buffer; sampleRate: number } {
  // Find "data" chunk
  let offset = 12; // Skip RIFF header
  let sampleRate = 24000;

  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      // Read sample rate from fmt chunk
      sampleRate = wavBuffer.readUInt32LE(offset + 12);
    } else if (chunkId === "data") {
      // Extract PCM data
      const pcm = wavBuffer.subarray(offset + 8, offset + 8 + chunkSize);
      return { pcm, sampleRate };
    }

    offset += 8 + chunkSize;
  }

  // Fallback: assume 44-byte header
  return {
    pcm: wavBuffer.subarray(44),
    sampleRate: parseWavSampleRate(wavBuffer),
  };
}

class ChatterboxProvider implements TTSProvider {
  readonly metadata: VoicePluginMetadata = {
    name: "chatterbox",
    version: "1.0.0",
    type: "tts",
    description: "High-quality TTS via Chatterbox (OpenAI-compatible)",
    capabilities: ["voice-selection", "voice-cloning", "expressiveness"],
    local: true,
    emoji: "🎭",
  };

  readonly voices: Voice[] = [
    { id: "default", name: "Default", language: "en", gender: "neutral" },
  ];

  private config: Required<ChatterboxConfig>;
  private dynamicVoices: Voice[] = [];

  constructor(config: ChatterboxConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  validateConfig(): void {
    if (!this.config.serverUrl) {
      throw new Error("serverUrl is required");
    }
  }

  /**
   * Fetch available voices from the server
   */
  async fetchVoices(): Promise<void> {
    try {
      const response = await fetch(`${this.config.serverUrl}/voices`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) {
          this.dynamicVoices = data.map((v: any) => ({
            id: v.id || v.name || v,
            name: v.name || v.id || v,
            language: v.language || "en",
            gender: v.gender || "neutral",
            description: v.description,
          }));
        }
      }
    } catch {
      // Voice fetch failed, use defaults
    }
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSSynthesisResult> {
    const startTime = Date.now();
    const voice = options?.voice || this.config.voice;

    // Build request body (OpenAI-compatible format)
    const requestBody = {
      input: text,
      voice: voice,
      model: "chatterbox", // Some servers require this
      response_format: "wav",
      // Chatterbox-specific parameters
      exaggeration: this.config.exaggeration,
      cfg_weight: this.config.cfgWeight,
      temperature: this.config.temperature,
    };

    // Try OpenAI-compatible endpoint first, fall back to native endpoint
    let response: Response;
    try {
      response = await fetch(`${this.config.serverUrl}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60000), // TTS can take a while
      });
    } catch (err) {
      // Try native Chatterbox endpoint
      response = await fetch(`${this.config.serverUrl}/synthesize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          voice,
          exaggeration: this.config.exaggeration,
          cfg_weight: this.config.cfgWeight,
          temperature: this.config.temperature,
        }),
        signal: AbortSignal.timeout(60000),
      });
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Chatterbox TTS error: ${response.status} - ${error}`);
    }

    // Get audio data
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
    } catch {
      // Try root endpoint as fallback
      try {
        const response = await fetch(this.config.serverUrl, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
        });
        return response.ok || response.status === 404; // Some servers return 404 on root
      } catch {
        return false;
      }
    }
  }

  async shutdown(): Promise<void> {
    // No cleanup needed
  }
}

let provider: ChatterboxProvider | null = null;

const plugin: WOPRPlugin = {
  name: "voice-chatterbox",
  version: "1.0.0",
  description: "High-quality TTS via Chatterbox",

  async init(ctx: WOPRPluginContext) {
    const config = ctx.getConfig<ChatterboxConfig>();
    provider = new ChatterboxProvider(config);

    try {
      provider.validateConfig();
      const healthy = await provider.healthCheck();
      if (healthy) {
        // Fetch available voices
        await provider.fetchVoices();
        ctx.registerTTSProvider(provider);
        ctx.log.info(`Chatterbox TTS registered (${provider["config"].serverUrl})`);
      } else {
        ctx.log.warn(`Chatterbox server not reachable at ${provider["config"].serverUrl}`);
      }
    } catch (err) {
      ctx.log.error(`Failed to init Chatterbox TTS: ${err}`);
    }
  },

  async shutdown() {
    if (provider) {
      await provider.shutdown();
      provider = null;
    }
  },
};

export default plugin;
