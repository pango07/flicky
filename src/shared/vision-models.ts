export interface VisionModelEntry {
  tag: string;
  name: string;
  description: string;
  sizeLabel: string;
  /** Ollama.com library path for the "Browse" link */
  librarySlug: string;
}

export const VISION_MODEL_CATALOG: VisionModelEntry[] = [
  {
    tag: 'qwen3-vl:8b',
    name: 'Qwen3-VL 8B',
    description: "Alibaba's latest vision-language model — strong OCR, charts, video frames",
    sizeLabel: '~5 GB',
    librarySlug: 'qwen3-vl',
  },
  {
    tag: 'qwen2.5-vl:7b',
    name: 'Qwen2.5-VL 7B',
    description: 'Solid all-round vision model; good at document understanding',
    sizeLabel: '~5 GB',
    librarySlug: 'qwen2.5-vl',
  },
  {
    tag: 'llava:13b',
    name: 'LLaVA 13B',
    description: 'Reliable visual Q&A; widely tested with Ollama',
    sizeLabel: '~8 GB',
    librarySlug: 'llava',
  },
  {
    tag: 'llava:7b',
    name: 'LLaVA 7B',
    description: 'Lighter LLaVA variant — faster on modest hardware',
    sizeLabel: '~4.5 GB',
    librarySlug: 'llava',
  },
  {
    tag: 'llava-llama3:8b',
    name: 'LLaVA-LLaMA3 8B',
    description: 'LLaVA fine-tuned on LLaMA 3 — improved reasoning',
    sizeLabel: '~5 GB',
    librarySlug: 'llava-llama3',
  },
  {
    tag: 'llava-phi3:medium',
    name: 'LLaVA-Phi3 Medium',
    description: 'Microsoft Phi-3 backbone; efficient for mid-range GPUs',
    sizeLabel: '~8 GB',
    librarySlug: 'llava-phi3',
  },
  {
    tag: 'minicpm-v:8b',
    name: 'MiniCPM-V 8B',
    description: 'Excellent at fine-grained image detail and Chinese text',
    sizeLabel: '~5 GB',
    librarySlug: 'minicpm-v',
  },
  {
    tag: 'moondream:latest',
    name: 'Moondream',
    description: 'Tiny vision model (~1.6B) — very fast on CPU',
    sizeLabel: '~1 GB',
    librarySlug: 'moondream',
  },
  {
    tag: 'granite3.2-vision:2b',
    name: 'Granite 3.2 Vision 2B',
    description: 'IBM Granite vision model; strong at document and chart Q&A',
    sizeLabel: '~2 GB',
    librarySlug: 'granite3.2-vision',
  },
  {
    tag: 'gemma3:12b',
    name: 'Gemma 3 12B',
    description: "Google's Gemma 3 with built-in vision capability",
    sizeLabel: '~8 GB',
    librarySlug: 'gemma3',
  },
  {
    tag: 'gemma4:e4b',
    name: 'Gemma 4 E4B',
    description: "Google's Gemma 4 edge model — vision + text, efficient on CPU",
    sizeLabel: '~9.5 GB',
    librarySlug: 'gemma4',
  },
];

// Name fragments of model families known to accept image input. Matched
// as substrings of the lowercased model id, so provider prefixes like
// `meta-llama/` or a connection's prefixId don't get in the way.
export const VISION_FAMILIES = [
  'llava', 'bakllava', 'moondream', 'cogvlm', 'minicpm-v',
  'llava-llama3', 'llava-phi3', 'granite3.2-vision',
  'qwen2-vl', 'qwen2.5-vl', 'qwen3-vl',
  'llava-v1.6', 'llava-v1.5',
  'gemma3', 'gemma4', 'mistral-small3.1', 'devstral',
  'llama3.2-vision', 'llama-4', 'llama4', 'pixtral',
];

export function isVisionModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return VISION_FAMILIES.some((f) => lower.includes(f));
}
