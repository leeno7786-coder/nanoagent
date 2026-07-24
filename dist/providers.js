import { fetchLMStudioModels, isLMStudioURL, parseParamBillionsFromModelId } from './model-runtime.js';
import { isLocalProvider } from './llm.js';
/**
 * Default list of runtime providers (connectors) with their available models.
 * These can be extended or customized via configuration.
 */
export const RUNTIME_PROVIDERS = [
    {
        id: 'openai',
        name: 'OpenAI',
        baseURL: 'https://api.openai.com/v1',
        requiresAuth: true,
        apiKeyEnvVar: 'OPENAI_API_KEY',
        icon: '🤖',
        description: "OpenAI's official API (also hosts Qwen partner models)",
        docsUrl: 'https://platform.openai.com',
        models: [
            /* ─── Flagship ─── */
            {
                id: 'qwen3.7-max',
                name: 'Qwen3.7 Max',
                description: 'Largest and most capable Qwen3.7 series model',
            },
            {
                id: 'qwen3.6-plus',
                name: 'Qwen3.6 Plus',
                description: 'Native vision-language with top-tier coding and OCR',
            },
            {
                id: 'qwen3.6-max',
                name: 'Qwen3.6 Max',
                description: 'Enhanced vibe coding and front-end skills',
            },
            {
                id: 'qwen3.6-27b',
                name: 'Qwen3.6 27B (Open)',
                description: 'Open-source hybrid vision-language model',
            },
            {
                id: 'qwen3.5-plus',
                name: 'Qwen3.5 Plus',
                description: 'Significant leap in text and multimodal capabilities',
            },
            {
                id: 'qwen3.5-27b',
                name: 'Qwen3.5 27B (Open)',
                description: 'Open-source hybrid MoE vision-language model',
            },
            {
                id: 'qwen3-max',
                name: 'Qwen3 Max',
                description: 'SOTA agent programming and tool invocation',
            },
            {
                id: 'qwen-plus',
                name: 'Qwen Plus',
                description: 'Enhanced super-large-scale language model',
            },
            {
                id: 'qwen-plus-character',
                name: 'Qwen Plus Character',
                description: 'Role-playing model with empathy and character consistency',
            },
            /* ─── Coding ─── */
            {
                id: 'qwen3-coder-plus',
                name: 'Qwen3 Coder Plus',
                description: 'Strong coding agent with tool invocation',
            },
            {
                id: 'qwen3-coder-flash',
                name: 'Qwen3 Coder Flash',
                description: 'Fast coding-specialized model with multi-turn tool interaction',
                default: true,
            },
            {
                id: 'qwen3-coder-next',
                name: 'Qwen3 Coder Next (Open)',
                description: 'Open-source hybrid coding model',
            },
            /* ─── Cost-optimized ─── */
            {
                id: 'qwen3.6-flash',
                name: 'Qwen3.6 Flash',
                description: 'Fast vision-language with strong agentic coding',
            },
            {
                id: 'qwen3.5-flash',
                name: 'Qwen3.5 Flash',
                description: 'Cost-effective vision-language model',
            },
            {
                id: 'qwen-flash',
                name: 'Qwen Flash',
                description: '1M context, thinking/non-thinking modes',
            },
            {
                id: 'qwen-flash-character',
                name: 'Qwen Flash Character',
                description: 'Fast role-playing with Japanese localization',
            },
            {
                id: 'qwen-turbo',
                name: 'Qwen Turbo',
                description: 'Fast, cost-efficient model',
            },
            /* ─── Vision-Language ─── */
            {
                id: 'qwen3-vl-plus',
                name: 'Qwen3 VL Plus',
                description: 'World-leading visual agent capabilities',
            },
            {
                id: 'qwen3-vl-flash',
                name: 'Qwen3 VL Flash',
                description: 'Fast small-scale visual understanding',
            },
            /* ─── Multimodal ─── */
            {
                id: 'qwen3.5-omni-flash',
                name: 'Qwen3.5 Omni Flash',
                description: 'Text, image, audio, video understanding',
            },
            {
                id: 'qwen3.5-omni-flash-realtime',
                name: 'Qwen3.5 Omni Flash Realtime',
                description: 'Realtime multimodal with voice dialogue',
            },
            {
                id: 'qwen3.5-omni-plus',
                name: 'Qwen3.5 Omni Plus',
                description: 'Premium multimodal with long video understanding',
            },
            {
                id: 'qwen3.5-omni-plus-realtime',
                name: 'Qwen3.5 Omni Plus Realtime',
                description: 'Premium realtime multimodal dialogue',
            },
            /* ─── Third-party ─── */
            {
                id: 'deepseek-v4-flash',
                name: 'DeepSeek V4 Flash',
                description: 'DeepSeek open-source model via DashScope',
            },
            /* ─── OpenAI native ─── */
            {
                id: 'gpt-4o',
                name: 'GPT-4o',
                description: 'Latest flagship model with vision',
            },
            {
                id: 'gpt-4o-mini',
                name: 'GPT-4o Mini',
                description: 'Faster, more cost-effective model',
            },
            {
                id: 'gpt-4-turbo',
                name: 'GPT-4 Turbo',
                description: 'Optimized version of GPT-4',
            },
            {
                id: 'gpt-3.5-turbo',
                name: 'GPT-3.5 Turbo',
                description: 'Efficient, lower-cost model',
            },
            {
                id: 'o1',
                name: 'o1',
                description: 'Reasoning model for complex tasks',
            },
            {
                id: 'o1-mini',
                name: 'o1 Mini',
                description: 'Compact reasoning model',
            },
        ],
    },
    {
        id: 'nebius',
        name: 'Nebius Token Factory',
        baseURL: 'https://api.nebius.com',
        endpoint: '/ai/v1',
        requiresAuth: true,
        apiKeyEnvVar: 'NEBIUS_API_KEY',
        icon: '⭐',
        description: 'AI infrastructure platform with token-based billing',
        docsUrl: 'https://docs.nebius.com',
        models: [
            {
                id: 'yandexgpt',
                name: 'Yandex GPT',
                description: "Yandex's general-purpose language model",
                default: true,
            },
            {
                id: 'yandexgpt-lite',
                name: 'Yandex GPT Lite',
                description: 'Faster, more efficient version of Yandex GPT',
            },
            {
                id: 'gpt-4o-mini',
                name: 'GPT-4o Mini',
                description: "OpenAI's fast, cost-effective model via Nebius",
            },
            {
                id: 'gpt-4o',
                name: 'GPT-4o',
                description: "OpenAI's latest flagship model via Nebius",
            },
            {
                id: 'claude-3-5-sonnet',
                name: 'Claude 3.5 Sonnet',
                description: "Anthropic's balanced model via Nebius",
            },
            {
                id: 'claude-3-haiku',
                name: 'Claude 3 Haiku',
                description: "Anthropic's fastest model via Nebius",
            },
        ],
    },
    {
        id: 'poe',
        name: 'Poe',
        baseURL: 'https://poe.com/api',
        requiresAuth: true,
        apiKeyEnvVar: 'POE_API_KEY',
        icon: '🎯',
        description: 'Chatbot platform with access to multiple models',
        docsUrl: 'https://poe.com',
        models: [
            {
                id: 'claude-3-5-sonnet',
                name: 'Claude 3.5 Sonnet',
                description: "Anthropic's state-of-the-art model",
                default: true,
            },
            {
                id: 'claude-3-opus',
                name: 'Claude 3 Opus',
                description: 'Most powerful Claude model',
            },
            {
                id: 'gpt-4o',
                name: 'GPT-4o',
                description: "OpenAI's latest flagship model",
            },
            {
                id: 'gpt-4-turbo',
                name: 'GPT-4 Turbo',
                description: 'Optimized version of GPT-4',
            },
            {
                id: 'llama-3.1-70b',
                name: 'Llama 3.1 70B',
                description: "Meta's latest open model",
            },
            {
                id: 'mistral-large',
                name: 'Mistral Large',
                description: "Mistral's top-tier model",
            },
            {
                id: 'gemini-1.5-pro',
                name: 'Gemini 1.5 Pro',
                description: "Google's advanced model",
            },
        ],
    },
    {
        id: 'search',
        name: 'Search',
        baseURL: 'https://api.search.ai',
        requiresAuth: true,
        apiKeyEnvVar: 'SEARCH_API_KEY',
        icon: '🔍',
        description: 'Search-based AI platform',
        models: [
            {
                id: 'search-70b',
                name: 'Search 70B',
                description: '70B parameter search-optimized model',
                default: true,
            },
            {
                id: 'search-400b',
                name: 'Search 400B',
                description: '400B parameter flagship model',
            },
            {
                id: 'search-v2',
                name: 'Search v2',
                description: 'Latest version of Search model',
            },
        ],
    },
    {
        id: 'helicone',
        name: 'Helicone',
        baseURL: 'https://api.helicone.ai',
        requiresAuth: true,
        apiKeyEnvVar: 'HELICONE_API_KEY',
        icon: '🚁',
        description: 'AI observability and proxy platform',
        docsUrl: 'https://helicone.ai',
        models: [
            {
                id: 'gpt-4o',
                name: 'GPT-4o',
                default: true,
            },
            {
                id: 'gpt-4-turbo',
                name: 'GPT-4 Turbo',
            },
            {
                id: 'claude-3-5-sonnet',
                name: 'Claude 3.5 Sonnet',
            },
            {
                id: 'llama-3.1-70b',
                name: 'Llama 3.1 70B',
            },
            {
                id: 'mistral-large',
                name: 'Mistral Large',
            },
        ],
    },
    {
        id: 'ollama-cloud',
        name: 'Ollama Cloud',
        baseURL: 'https://cloud.ollama.ai',
        requiresAuth: true,
        apiKeyEnvVar: 'OLLAMA_CLOUD_API_KEY',
        icon: '☁️',
        description: 'Cloud-hosted open-source models',
        docsUrl: 'https://ollama.ai',
        models: [
            {
                id: 'llama3.1-70b',
                name: 'Llama 3.1 70B',
                description: "Meta's latest open model",
                default: true,
            },
            {
                id: 'llama3.1-8b',
                name: 'Llama 3.1 8B',
                description: 'Smaller, faster Llama 3.1 variant',
            },
            {
                id: 'mistral-large',
                name: 'Mistral Large',
                description: "Mistral's large model",
            },
            {
                id: 'phi-3.5-mini',
                name: 'Phi 3.5 Mini',
                description: "Microsoft's lightweight model",
            },
            {
                id: 'qwen2.5-coder-7b',
                name: 'Qwen 2.5 Coder 7B',
                description: "Alibaba's code-specialized model",
            },
            {
                id: 'gemma-7b',
                name: 'Gemma 7B',
                description: "Google's open model",
            },
        ],
    },
    {
        id: 'z-ai-coding',
        name: 'Z.AI Coding Plan',
        baseURL: 'https://api.z.ai',
        requiresAuth: true,
        apiKeyEnvVar: 'ZAI_API_KEY',
        icon: '💎',
        description: 'AI coding assistant platform',
        docsUrl: 'https://z.ai',
        models: [
            {
                id: 'z-coder-32k',
                name: 'Z Coder 32K',
                description: '32K context coding model',
                default: true,
            },
            {
                id: 'z-coder-128k',
                name: 'Z Coder 128K',
                description: '128K context coding model',
            },
            {
                id: 'z-pro',
                name: 'Z Pro',
                description: 'Professional coding assistant',
            },
        ],
    },
    {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
        requiresAuth: true,
        apiKeyEnvVar: 'AWS_ACCESS_KEY_ID',
        icon: '🏗️',
        description: 'AWS AI model platform',
        docsUrl: 'https://aws.amazon.com/bedrock',
        models: [
            {
                id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
                name: 'Claude 3.5 Sonnet v2',
                description: "Anthropic's latest Sonnet model",
                default: true,
            },
            {
                id: 'anthropic.claude-3-opus-20240229-v1:0',
                name: 'Claude 3 Opus',
                description: "Anthropic's most powerful model",
            },
            {
                id: 'anthropic.claude-3-sonnet-20240229-v1:0',
                name: 'Claude 3 Sonnet',
                description: "Anthropic's balanced model",
            },
            {
                id: 'meta.llama3-1-70b-instruct-v1:0',
                name: 'Llama 3.1 70B Instruct',
                description: "Meta's latest instruct model",
            },
            {
                id: 'meta.llama3-1-8b-instruct-v1:0',
                name: 'Llama 3.1 8B Instruct',
                description: 'Lightweight Llama 3.1 model',
            },
            {
                id: 'mistral.mistral-large-2407-v1:0',
                name: 'Mistral Large',
                description: "Mistral's large model",
            },
            {
                id: 'mistral.mixtral-8x7b-instruct-v0:1',
                name: 'Mixtral 8x7B Instruct',
                description: "Mistral's mixture of experts model",
            },
            {
                id: 'cohere.command-r-plus-v1:0',
                name: 'Command R+',
                description: "Cohere's advanced model",
            },
            {
                id: 'ai21.j2-ultra-v1',
                name: 'Jurassic-2 Ultra',
                description: "AI21's ultra model",
            },
        ],
    },
    {
        id: 'the-grid',
        name: 'The Grid AI',
        baseURL: 'https://api.thegrid.ai',
        requiresAuth: true,
        apiKeyEnvVar: 'GRID_API_KEY',
        icon: '🔲',
        description: 'Decentralized AI network',
        docsUrl: 'https://thegrid.ai',
        models: [
            {
                id: 'grid-70b',
                name: 'Grid 70B',
                description: '70B parameter Grid model',
                default: true,
            },
            {
                id: 'grid-8b',
                name: 'Grid 8B',
                description: '8B parameter Grid model',
            },
        ],
    },
    {
        id: 'baseten',
        name: 'Baseten',
        baseURL: 'https://app.baseten.co/api',
        requiresAuth: true,
        apiKeyEnvVar: 'BASETEN_API_KEY',
        icon: '🏢',
        description: 'Model deployment and inference platform',
        docsUrl: 'https://baseten.co',
        models: [
            {
                id: 'auto',
                name: 'Auto (Deployed Models)',
                description: 'Your deployed models on Baseten',
                default: true,
            },
        ],
    },
    {
        id: 'frogbot',
        name: 'FrogBot',
        baseURL: 'https://api.frogbot.ai',
        requiresAuth: true,
        apiKeyEnvVar: 'FROGBOT_API_KEY',
        icon: '🐸',
        description: 'AI model gateway and router',
        docsUrl: 'https://frogbot.ai',
        models: [
            {
                id: 'gpt-4o-mini',
                name: 'GPT-4o Mini',
                description: 'Cost-effective OpenAI model',
                default: true,
            },
            {
                id: 'gpt-4o',
                name: 'GPT-4o',
                description: "OpenAI's flagship model",
            },
            {
                id: 'claude-3-5-sonnet',
                name: 'Claude 3.5 Sonnet',
                description: "Anthropic's state-of-the-art model",
            },
            {
                id: 'llama-3.1-70b',
                name: 'Llama 3.1 70B',
                description: "Meta's open model",
            },
        ],
    },
    {
        id: 'zhipu',
        name: 'Zhipu AI Coding Plan',
        baseURL: 'https://open.bigmodel.cn',
        requiresAuth: true,
        apiKeyEnvVar: 'ZHIPU_API_KEY',
        icon: '🧩',
        description: 'Chinese AI model provider with coding focus',
        docsUrl: 'https://bigmodel.cn',
        models: [
            {
                id: 'glm-4-flash',
                name: 'GLM-4 Flash',
                description: 'Fast, efficient coding model',
                default: true,
            },
            {
                id: 'glm-4',
                name: 'GLM-4',
                description: "Zhipu's flagship model",
            },
            {
                id: 'glm-4-air',
                name: 'GLM-4 Air',
                description: 'Lightweight, fast model',
            },
            {
                id: 'codegeex4',
                name: 'CodeGeeX4',
                description: 'Coding-specialized model',
            },
        ],
    },
    {
        id: 'lmstudio',
        name: 'LM Studio',
        baseURL: 'http://localhost:1234/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '💻',
        description: 'Local LM Studio inference server',
        docsUrl: 'http://127.0.0.1:1234',
        models: [], // Will be fetched dynamically
    },
    {
        id: 'ollama',
        name: 'Ollama',
        baseURL: 'http://localhost:11434/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '🦙',
        description: 'Local Ollama model runner & API server',
        docsUrl: 'https://ollama.com',
        models: [],
    },
    {
        id: 'foundry-local',
        name: 'Foundry Local',
        baseURL: 'http://localhost:5272/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '🏗️',
        description: 'Microsoft Azure AI Foundry Local Engine',
        docsUrl: 'https://ai.azure.com',
        models: [],
    },
    {
        id: 'llamacpp',
        name: 'llama.cpp',
        baseURL: 'http://localhost:8080/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '🦙',
        description: 'Local llama.cpp HTTP server (OpenAI compatible)',
        docsUrl: 'https://github.com/ggerganov/llama.cpp',
        models: [],
    },
    {
        id: 'fastflowlm',
        name: 'FastFlowLM',
        baseURL: 'http://localhost:8000/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '⚡',
        description: 'High-efficiency FastFlowLM local runtime',
        docsUrl: 'https://github.com/fastflowlm',
        models: [],
    },
    {
        id: 'vllm',
        name: 'vLLM',
        baseURL: 'http://localhost:8000/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '🚀',
        description: 'High-throughput local vLLM inference server',
        docsUrl: 'https://github.com/vllm-project/vllm',
        models: [],
    },
    {
        id: 'jan',
        name: 'Jan',
        baseURL: 'http://localhost:1337/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '🤖',
        description: 'Open-source local AI desktop assistant & server',
        docsUrl: 'https://jan.ai',
        models: [],
    },
    {
        id: 'localai',
        name: 'LocalAI',
        baseURL: 'http://localhost:8080/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '🏡',
        description: 'Self-hosted local OpenAI alternative',
        docsUrl: 'https://localai.io',
        models: [],
    },
    {
        id: 'oobabooga',
        name: 'Text Generation WebUI',
        baseURL: 'http://localhost:5000/v1',
        requiresAuth: false,
        isLocal: true,
        dynamicModels: true,
        icon: '💬',
        description: 'oobabooga Text Generation WebUI OpenAI API server',
        docsUrl: 'https://github.com/oobabooga/text-generation-webui',
        models: [],
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        baseURL: 'https://api.anthropic.com/v1',
        requiresAuth: true,
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        icon: '🦭',
        description: "Anthropic's Claude models",
        docsUrl: 'https://anthropic.com',
        models: [
            {
                id: 'claude-3-5-sonnet-20241022',
                name: 'Claude 3.5 Sonnet',
                description: 'Latest Sonnet model',
                default: true,
            },
            {
                id: 'claude-3-opus-20240229',
                name: 'Claude 3 Opus',
                description: 'Most powerful Claude model',
            },
            {
                id: 'claude-3-sonnet-20240229',
                name: 'Claude 3 Sonnet',
                description: 'Balanced model for most tasks',
            },
            {
                id: 'claude-3-haiku-20240307',
                name: 'Claude 3 Haiku',
                description: 'Fastest, most cost-effective model',
            },
            {
                id: 'claude-2:1',
                name: 'Claude 2.1',
                description: 'Previous generation model',
            },
        ],
    },
    {
        id: 'google',
        name: 'Google',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        requiresAuth: true,
        apiKeyEnvVar: 'GOOGLE_API_KEY',
        icon: '🔍',
        description: "Google's Gemini models",
        docsUrl: 'https://ai.google.dev',
        models: [
            {
                id: 'gemini-1.5-pro',
                name: 'Gemini 1.5 Pro',
                description: "Google's advanced model with long context",
                default: true,
            },
            {
                id: 'gemini-1.5-flash',
                name: 'Gemini 1.5 Flash',
                description: 'Faster, more cost-effective model',
            },
            {
                id: 'gemini-2.0-pro',
                name: 'Gemini 2.0 Pro',
                description: 'Latest generation model',
            },
            {
                id: 'gemini-2.0-flash',
                name: 'Gemini 2.0 Flash',
                description: 'Fast, efficient model',
            },
        ],
    },
    {
        id: 'mistral',
        name: 'Mistral AI',
        baseURL: 'https://api.mistral.ai/v1',
        requiresAuth: true,
        apiKeyEnvVar: 'MISTRAL_API_KEY',
        icon: '🌪️',
        description: "Mistral's models",
        docsUrl: 'https://mistral.ai',
        models: [
            {
                id: 'mistral-large-latest',
                name: 'Mistral Large (Latest)',
                description: 'Latest Mistral Large flagship model, 128k context',
                default: true,
            },
            {
                id: 'mistral-small-latest',
                name: 'Mistral Small (Latest)',
                description: 'Fast, cost-effective model, 32k context',
            },
            {
                id: 'codestral-latest',
                name: 'Codestral (Latest)',
                description: 'Coding-specialized model, 256k context',
            },
            {
                id: 'open-mistral-nemo',
                name: 'Open Mistral Nemo',
                description: 'Open-weight model with 128k context',
            },
            {
                id: 'ministral-8b-latest',
                name: 'Ministral 8B (Latest)',
                description: 'Efficient 8B parameter edge model',
            },
            {
                id: 'mistral-embed',
                name: 'Mistral Embed',
                description: 'Embedding model for text representations',
            },
        ],
    },
    {
        id: 'cohere',
        name: 'Cohere',
        baseURL: 'https://api.cohere.ai/v1',
        requiresAuth: true,
        apiKeyEnvVar: 'COHERE_API_KEY',
        icon: '✨',
        description: "Cohere's AI models",
        docsUrl: 'https://cohere.ai',
        models: [
            {
                id: 'command-r-plus',
                name: 'Command R+',
                description: 'Advanced model with tool use',
                default: true,
            },
            {
                id: 'command-r',
                name: 'Command R',
                description: 'Reasoning model',
            },
            {
                id: 'command',
                name: 'Command',
                description: 'General-purpose model',
            },
            {
                id: 'embed-english-v3.0',
                name: 'Embed English v3',
                description: 'Embedding model',
            },
        ],
    },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        baseURL: 'https://openrouter.ai/api/v1',
        requiresAuth: true,
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        icon: '🌐',
        description: 'OpenRouter API - Access 300+ models through a unified API',
        docsUrl: 'https://openrouter.ai',
        dynamicModels: true,
        models: [], // Will be fetched dynamically from OpenRouter API
    },
];
/**
 * Sanitize a URL to remove any embedded API keys.
 * This prevents accidental exposure of API keys in URLs.
 */
export function sanitizeBaseURL(url) {
    if (!url)
        return url;
    try {
        // Remove basic auth (user:password@host) - preserve protocol
        // Match protocol://user:password@ and replace with protocol://
        let sanitized = url.replace(/(https?:\/\/)[^/]+:[^@]+@/, '$1');
        // Remove API key from query string
        // Match ?key=value or &key=value and replace with just the separator
        sanitized = sanitized.replace(/([?&])(api_key|key)=[^&]+/gi, '$1');
        // Clean up: replace ?& with ?, && with &, trailing ? or &
        sanitized = sanitized.replace(/\?&/g, '?');
        sanitized = sanitized.replace(/&&+/g, '&');
        sanitized = sanitized.replace(/[?&]$/, '');
        return sanitized;
    }
    catch {
        return url;
    }
}
/**
 * Build the full API base URL for a provider, merging baseURL + endpoint.
 */
export function getProviderBaseURL(provider) {
    if (!provider)
        return '';
    let url = sanitizeBaseURL(provider.baseURL || '');
    if (provider.endpoint) {
        url = url.replace(/\/+$/, '') + provider.endpoint;
    }
    return url;
}
/**
 * Get a provider by its ID.
 */
export function getProvider(id) {
    const lowerId = id.toLowerCase();
    return RUNTIME_PROVIDERS.find((p) => p.id.toLowerCase() === lowerId);
}
/**
 * Get all provider IDs.
 */
export function getProviderIds() {
    return RUNTIME_PROVIDERS.map((p) => p.id);
}
/**
 * Get a model by provider ID and model ID.
 */
export function getModel(providerId, modelId) {
    const provider = getProvider(providerId);
    return provider?.models.find((m) => m.id === modelId);
}
/**
 * Get the default model for a provider.
 */
export function getDefaultModel(providerId) {
    const provider = getProvider(providerId);
    return provider?.models.find((m) => m.default) || provider?.models[0];
}
/**
 * Check if a provider exists.
 */
export function hasProvider(id) {
    const lowerId = id.toLowerCase();
    return RUNTIME_PROVIDERS.some((p) => p.id.toLowerCase() === lowerId);
}
/**
 * Search providers by name or description.
 */
export function searchProviders(query) {
    const lowerQuery = query.toLowerCase();
    return RUNTIME_PROVIDERS.filter((p) => p.name.toLowerCase().includes(lowerQuery) ||
        p.description?.toLowerCase().includes(lowerQuery) ||
        p.id.toLowerCase().includes(lowerQuery));
}
/**
 * Get local providers (those that run on localhost).
 */
export function getLocalProviders() {
    return RUNTIME_PROVIDERS.filter((p) => p.isLocal);
}
/**
 * Get remote providers (those that require API keys).
 */
export function getRemoteProviders() {
    return RUNTIME_PROVIDERS.filter((p) => !p.isLocal && p.requiresAuth);
}
/**
 * Check if a provider requires an API key.
 */
export function providerRequiresAuth(providerId) {
    const provider = getProvider(providerId);
    return provider?.requiresAuth === true;
}
/**
 * Get the API key environment variable name for a provider.
 */
export function getApiKeyEnvVar(providerId) {
    const provider = getProvider(providerId);
    return provider?.apiKeyEnvVar;
}
/**
 * Fetch models from a local OpenAI-compatible runtime.
 * This makes a request to the runtime's /models endpoint.
 * Only works for local providers (LM Studio, local Ollama, etc.) - not for cloud APIs.
 */
export async function fetchLocalModels(baseURL) {
    // Only fetch from local providers - cloud APIs don't support /models endpoint
    if (!isLocalProvider(baseURL)) {
        console.log('Skipping model fetch for non-local provider:', baseURL);
        return [];
    }
    try {
        let apiBase = baseURL.replace(/\/+$/, '');
        if (!apiBase.endsWith('/v1')) {
            apiBase += '/v1';
        }
        if (isLMStudioURL(apiBase)) {
            const lsModels = await fetchLMStudioModels(apiBase);
            if (lsModels.length > 0)
                return lsModels;
        }
        try {
            const response = await fetch(`${apiBase}/models`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(3000),
            });
            if (response.ok) {
                const body = await response.json();
                const modelResponse = body;
                if (modelResponse?.data && Array.isArray(modelResponse.data)) {
                    return modelResponse.data.map((m) => {
                        const id = m.id || m.name || 'unknown';
                        const params = parseParamBillionsFromModelId(id);
                        const paramsStr = params ? (params < 1 ? `${Math.round(params * 1000)}M` : `${params}B`) : '';
                        return {
                            id,
                            name: m.name || id,
                            description: [paramsStr, m.description].filter(Boolean).join(' · '),
                            paramBillions: params,
                        };
                    });
                }
                if (Array.isArray(body)) {
                    return body.map((m) => {
                        const id = m.id || m.name || 'unknown';
                        const params = parseParamBillionsFromModelId(id);
                        const paramsStr = params ? (params < 1 ? `${Math.round(params * 1000)}M` : `${params}B`) : '';
                        return {
                            id,
                            name: m.name || id,
                            description: [paramsStr, m.description].filter(Boolean).join(' · '),
                            paramBillions: params,
                        };
                    });
                }
            }
        }
        catch {
            /* Fall back to Ollama native tags API */
        }
        // Fallback for native Ollama tag list endpoint
        const rawHost = baseURL.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
        try {
            const ollamaRes = await fetch(`${rawHost}/api/tags`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(3000),
            });
            if (ollamaRes.ok) {
                const body = (await ollamaRes.json());
                if (body?.models && Array.isArray(body.models)) {
                    return body.models.map((m) => {
                        const id = m.name;
                        const params = parseParamBillionsFromModelId(id);
                        const sizeGb = m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)}GB` : '';
                        const paramsStr = params ? (params < 1 ? `${Math.round(params * 1000)}M` : `${params}B`) : '';
                        return {
                            id,
                            name: id,
                            description: [paramsStr, sizeGb].filter(Boolean).join(' · '),
                            paramBillions: params,
                        };
                    });
                }
            }
        }
        catch {
            /* ignore */
        }
        return [];
    }
    catch (error) {
        console.error('Error fetching local models:', error);
        return [];
    }
}
/**
 * Check if a local runtime is accessible.
 * Only works for local providers (LM Studio, local Ollama, etc.) - not for cloud APIs.
 */
export async function checkRuntimeHealth(baseURL) {
    if (!isLocalProvider(baseURL)) {
        return false;
    }
    try {
        let healthUrl = baseURL.replace(/\/+$/, '');
        if (!healthUrl.endsWith('/v1')) {
            healthUrl += '/v1';
        }
        try {
            const response = await fetch(`${healthUrl}/models`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(2500),
            });
            if (response.ok)
                return true;
        }
        catch { }
        // Ollama API tags fallback check
        const rawHost = baseURL.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
        try {
            const response = await fetch(`${rawHost}/api/tags`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(2500),
            });
            if (response.ok)
                return true;
        }
        catch { }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Fetch models from OpenRouter API.
 * OpenRouter provides a unified API for 300+ models from various providers.
 */
export async function fetchOpenRouterModels(apiKey) {
    try {
        const url = 'https://openrouter.ai/api/v1/models?sort=pricing-low-to-high';
        const headers = {
            'Content-Type': 'application/json',
        };
        // Add authorization header if API key is provided
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        const response = await fetch(url, {
            method: 'GET',
            headers: headers,
            signal: AbortSignal.timeout(10000), // 10 second timeout
        });
        if (!response.ok) {
            console.error('Failed to fetch OpenRouter models:', response.status, response.statusText);
            return [];
        }
        const body = await response.json();
        const modelResponse = body;
        // OpenRouter API returns { data: [...] }
        if (modelResponse?.data && Array.isArray(modelResponse.data)) {
            return modelResponse.data.map((model) => ({
                id: model.id,
                name: model.name || model.id,
                description: model.description || '',
                contextLength: model.context_length,
                maxContextLength: model.context_length,
                ...(model.pricing
                    ? {
                        pricing: {
                            prompt: model.pricing.prompt,
                            completion: model.pricing.completion,
                        },
                    }
                    : {}),
            }));
        }
        return [];
    }
    catch (error) {
        console.error('Error fetching OpenRouter models:', error);
        return [];
    }
}
