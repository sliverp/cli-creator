import { initClixHome, writeConfig } from './config-store';
import type { TuiAdapter, TuiChoice } from './tui';
import { ReadlineTuiAdapter } from './tui';

const CUSTOM_MODEL_VALUE = '__custom_model__';

type ProviderPreset = {
  value: string;
  label: string;
  hint: string;
  defaultModel?: string;
  modelChoices: TuiChoice<string>[];
  defaultBaseUrl?: string;
  baseUrlHint: string;
  apiKeyEnvName?: string;
  apiKeyEnvHint: string;
  apiKeyOptional?: boolean;
};

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    value: 'openai',
    label: 'OpenAI',
    hint: '官方 API / GPT 系列',
    defaultModel: 'gpt-5',
    modelChoices: [
      { value: 'gpt-5', label: 'gpt-5', hint: '主力通用模型' },
      { value: 'gpt-5-mini', label: 'gpt-5-mini', hint: '更快更省' },
      { value: 'gpt-5-nano', label: 'gpt-5-nano', hint: '低成本批处理' },
      { value: 'gpt-4.1', label: 'gpt-4.1', hint: '兼容旧配置' },
      { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini', hint: '轻量模型' },
      { value: 'gpt-4o', label: 'gpt-4o', hint: '多模态' },
    ],
    baseUrlHint: '官方直连可留空；如需代理/网关可填自定义地址',
    apiKeyEnvName: 'OPENAI_API_KEY',
    apiKeyEnvHint: '常用：OPENAI_API_KEY',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude 系列',
    defaultModel: 'claude-sonnet-4-6',
    modelChoices: [
      { value: 'claude-opus-4-6', label: 'claude-opus-4-6', hint: '高质量推理' },
      { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', hint: '默认推荐' },
      { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', hint: '更快更省' },
    ],
    baseUrlHint: '官方直连可留空；如需代理/网关可填自定义地址',
    apiKeyEnvName: 'ANTHROPIC_API_KEY',
    apiKeyEnvHint: '常用：ANTHROPIC_API_KEY',
  },
  {
    value: 'azure-openai',
    label: 'Azure OpenAI',
    hint: 'Azure 托管 OpenAI',
    defaultModel: 'gpt-5',
    modelChoices: [
      { value: 'gpt-5', label: 'gpt-5', hint: 'Azure deployment name' },
      { value: 'gpt-5-mini', label: 'gpt-5-mini', hint: 'Azure deployment name' },
      { value: 'gpt-4.1', label: 'gpt-4.1', hint: 'Azure deployment name' },
      { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini', hint: 'Azure deployment name' },
    ],
    baseUrlHint: '通常形如 https://{resource}.openai.azure.com/openai/v1',
    apiKeyEnvName: 'AZURE_OPENAI_API_KEY',
    apiKeyEnvHint: '常用：AZURE_OPENAI_API_KEY',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    hint: '聚合多家模型提供方',
    defaultModel: 'openai/gpt-5',
    modelChoices: [
      { value: 'openai/gpt-5', label: 'openai/gpt-5', hint: 'OpenAI via OpenRouter' },
      { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4', hint: 'Claude via OpenRouter' },
      { value: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro', hint: 'Gemini via OpenRouter' },
      { value: 'deepseek/deepseek-chat', label: 'deepseek/deepseek-chat', hint: 'DeepSeek via OpenRouter' },
    ],
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    baseUrlHint: '回车可使用 OpenRouter 官方地址',
    apiKeyEnvName: 'OPENROUTER_API_KEY',
    apiKeyEnvHint: '常用：OPENROUTER_API_KEY',
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    hint: 'Google AI Studio / Vertex AI',
    defaultModel: 'gemini-2.5-pro',
    modelChoices: [
      { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro', hint: '高质量' },
      { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash', hint: '速度优先' },
      { value: 'gemini-2.0-flash', label: 'gemini-2.0-flash', hint: '兼顾成本' },
    ],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    baseUrlHint: '回车可使用 Gemini OpenAI 兼容地址；官方 SDK 方式也可改成自定义地址',
    apiKeyEnvName: 'GEMINI_API_KEY',
    apiKeyEnvHint: '常用：GEMINI_API_KEY 或 GOOGLE_API_KEY',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    hint: 'DeepSeek 官方 API',
    defaultModel: 'deepseek-chat',
    modelChoices: [
      { value: 'deepseek-chat', label: 'deepseek-chat', hint: '通用' },
      { value: 'deepseek-reasoner', label: 'deepseek-reasoner', hint: '推理增强' },
    ],
    defaultBaseUrl: 'https://api.deepseek.com',
    baseUrlHint: '回车可使用 DeepSeek 官方地址',
    apiKeyEnvName: 'DEEPSEEK_API_KEY',
    apiKeyEnvHint: '常用：DEEPSEEK_API_KEY',
  },
  {
    value: 'qwen',
    label: 'Qwen',
    hint: '阿里云百炼 / DashScope',
    defaultModel: 'qwen-max',
    modelChoices: [
      { value: 'qwen-max', label: 'qwen-max', hint: '旗舰模型' },
      { value: 'qwen-plus', label: 'qwen-plus', hint: '平衡' },
      { value: 'qwen-turbo', label: 'qwen-turbo', hint: '速度优先' },
    ],
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlHint: '回车可使用 DashScope OpenAI 兼容地址',
    apiKeyEnvName: 'DASHSCOPE_API_KEY',
    apiKeyEnvHint: '常用：DASHSCOPE_API_KEY',
  },
  {
    value: 'kimi',
    label: 'Moonshot / Kimi',
    hint: 'Moonshot 官方 API',
    defaultModel: 'kimi-k2',
    modelChoices: [
      { value: 'kimi-k2', label: 'kimi-k2', hint: '代码与通用任务' },
      { value: 'kimi-latest', label: 'kimi-latest', hint: '通用别名' },
      { value: 'moonshot-v1-128k', label: 'moonshot-v1-128k', hint: '长上下文' },
    ],
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    baseUrlHint: '回车可使用 Moonshot 官方地址',
    apiKeyEnvName: 'MOONSHOT_API_KEY',
    apiKeyEnvHint: '常用：MOONSHOT_API_KEY',
  },
  {
    value: 'zhipu',
    label: 'Zhipu GLM',
    hint: '智谱 AI',
    defaultModel: 'glm-4.5',
    modelChoices: [
      { value: 'glm-4.5', label: 'glm-4.5', hint: '旗舰模型' },
      { value: 'glm-4.5-air', label: 'glm-4.5-air', hint: '轻量版' },
      { value: 'glm-4v', label: 'glm-4v', hint: '视觉能力' },
    ],
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    baseUrlHint: '回车可使用智谱官方地址',
    apiKeyEnvName: 'ZHIPUAI_API_KEY',
    apiKeyEnvHint: '常用：ZHIPUAI_API_KEY',
  },
  {
    value: 'ollama',
    label: 'Ollama',
    hint: '本地模型服务',
    defaultModel: 'qwen2.5:14b',
    modelChoices: [
      { value: 'qwen2.5:14b', label: 'qwen2.5:14b', hint: '常见中文/代码本地模型' },
      { value: 'llama3.1:8b', label: 'llama3.1:8b', hint: '通用本地模型' },
      { value: 'deepseek-r1:14b', label: 'deepseek-r1:14b', hint: '推理本地模型' },
    ],
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    baseUrlHint: '回车可使用本地 Ollama 默认地址',
    apiKeyEnvHint: '本地 Ollama 通常不需要 API Key，可留空',
    apiKeyOptional: true,
  },
  {
    value: 'custom',
    label: 'Custom',
    hint: '自定义 OpenAI/Anthropic 兼容端点',
    modelChoices: [],
    baseUrlHint: '请输入你的网关或代理地址',
    apiKeyEnvHint: '如无需密钥可留空；常见自定义网关也会映射到 OPENAI_API_KEY',
    apiKeyOptional: true,
  },
];

const PRESET_BY_PROVIDER = new Map(PROVIDER_PRESETS.map((preset) => [preset.value, preset]));

export async function runInitWizard(input: { tui?: TuiAdapter } = {}) {
  const { paths, config, created } = await initClixHome();
  const adapter = input.tui ?? new ReadlineTuiAdapter();
  const ownsAdapter = !input.tui;

  try {
    // Show current config when re-running
    if (!created) {
      console.log('');
      console.log('当前配置:');
      console.log(`  llm.provider:       ${config.llm.provider}`);
      console.log(`  llm.model:          ${config.llm.model}`);
      console.log(`  llm.baseUrl:        ${config.llm.baseUrl ?? '(empty)'}`);
      if (config.llm.apiKey) {
        console.log(`  llm.apiKey:         ${maskSecret(config.llm.apiKey)}`);
      } else {
        console.log(`  llm.apiKeyEnvName:  ${config.llm.apiKeyEnvName ?? '(empty)'}`);
      }
      console.log(`  defaults.packageScope: ${config.defaults.packageScope ?? '(empty)'}`);
      console.log(`  defaults.publishTag:   ${config.defaults.publishTag}`);
      console.log(`  defaults.npmAccess:    ${config.defaults.npmAccess}`);
      console.log('');
    }

    const provider = await adapter.select({
      message: '请选择默认大模型提供方',
      defaultValue: resolveProviderDefault(config.llm.provider),
      choices: PROVIDER_PRESETS.map((preset) => ({
        value: preset.value,
        label: preset.label,
        hint: preset.hint,
      })),
    });

    const preset = PRESET_BY_PROVIDER.get(provider) ?? createCustomPreset(provider);
    const model = await promptModel({
      adapter,
      preset,
      currentProvider: config.llm.provider,
      currentModel: config.llm.model,
    });

    const baseUrl = await adapter.input({
      message: `请输入模型 Base URL（${preset.baseUrlHint}）`,
      defaultValue: resolveBaseUrlDefault({
        currentProvider: config.llm.provider,
        currentBaseUrl: config.llm.baseUrl,
        nextProvider: provider,
        preset,
      }),
      allowEmpty: true,
      validate: validateOptionalUrl,
    });

    const { apiKeyEnvName, apiKey } = await promptApiKey({
      adapter,
      preset,
      currentProvider: config.llm.provider,
      currentApiKeyEnvName: config.llm.apiKeyEnvName,
      currentApiKey: config.llm.apiKey,
      nextProvider: provider,
    });

    const packageScope = await adapter.input({
      message: '请输入默认 npm scope（可留空，例如 @your-scope）',
      defaultValue: config.defaults.packageScope ?? '',
      allowEmpty: true,
      validate: (value) => {
        if (!value.trim()) {
          return undefined;
        }
        return /^@[a-z0-9][a-z0-9-]*$/i.test(value.trim()) ? undefined : 'scope 必须形如 @your-scope';
      },
    });

    const publishTag = await adapter.input({
      message: '请输入默认发布 tag',
      defaultValue: config.defaults.publishTag,
      validate: (value) => (value.trim() ? undefined : '发布 tag 不能为空。'),
    });

    const npmAccess = await adapter.select({
      message: '请选择默认 npm access',
      defaultValue: config.defaults.npmAccess,
      choices: [
        { value: 'public', label: 'public', hint: '公开包，默认推荐' },
        { value: 'restricted', label: 'restricted', hint: '私有 scope 包' },
      ],
    });

    const nextConfig = structuredClone(config);
    nextConfig.llm.provider = provider;
    nextConfig.llm.model = model.trim();
    nextConfig.llm.baseUrl = baseUrl.trim() || undefined;
    nextConfig.llm.apiKeyEnvName = apiKeyEnvName?.trim() || undefined;
    nextConfig.llm.apiKey = apiKey?.trim() || undefined;
    nextConfig.defaults.packageScope = packageScope.trim() || undefined;
    nextConfig.defaults.publishTag = publishTag.trim();
    nextConfig.defaults.npmAccess = npmAccess;
    nextConfig.updatedAt = new Date().toISOString();

    printConfigPreview(nextConfig);

    const confirmed = await adapter.confirm({
      message: '确认写入以上初始化配置？',
      defaultValue: true,
    });

    if (!confirmed) {
      return { created, saved: false, paths, config };
    }

    await writeConfig(nextConfig, paths);
    return { created, saved: true, paths, config: nextConfig };
  } finally {
    if (ownsAdapter) {
      await adapter.close?.();
    }
  }
}

async function promptModel(args: {
  adapter: TuiAdapter;
  preset: ProviderPreset;
  currentProvider: string;
  currentModel: string;
}): Promise<string> {
  const { adapter, preset, currentProvider, currentModel } = args;
  if (preset.modelChoices.length === 0) {
    return adapter.input({
      message: '请输入默认模型名',
      defaultValue: currentProvider === preset.value ? currentModel : '',
      validate: (value) => (value.trim() ? undefined : '模型名不能为空。'),
    });
  }

  const choices = [...preset.modelChoices];
  const currentModelExists = currentProvider === preset.value && choices.some((choice) => choice.value === currentModel);
  if (currentProvider === preset.value && currentModel && !currentModelExists) {
    choices.unshift({
      value: currentModel,
      label: currentModel,
      hint: '当前配置',
    });
  }
  choices.push({
    value: CUSTOM_MODEL_VALUE,
    label: '手动输入模型名',
    hint: '列表里没有就选这个',
  });

  const selected = await adapter.select({
    message: '请选择默认模型',
    defaultValue: resolveModelDefault({ currentProvider, currentModel, preset }),
    choices,
  });

  if (selected !== CUSTOM_MODEL_VALUE) {
    return selected;
  }

  return adapter.input({
    message: '请输入默认模型名',
    defaultValue: currentProvider === preset.value ? currentModel : preset.defaultModel,
    validate: (value) => (value.trim() ? undefined : '模型名不能为空。'),
  });
}

function resolveProviderDefault(currentProvider: string): string {
  return PRESET_BY_PROVIDER.has(currentProvider) ? currentProvider : 'custom';
}

function resolveModelDefault(args: {
  currentProvider: string;
  currentModel: string;
  preset: ProviderPreset;
}): string | undefined {
  const { currentProvider, currentModel, preset } = args;
  if (currentProvider === preset.value && currentModel) {
    return currentModel;
  }
  return preset.defaultModel;
}

function resolveBaseUrlDefault(args: {
  currentProvider: string;
  currentBaseUrl?: string;
  nextProvider: string;
  preset: ProviderPreset;
}): string {
  if (args.currentProvider === args.nextProvider && args.currentBaseUrl) {
    return args.currentBaseUrl;
  }
  return args.preset.defaultBaseUrl ?? '';
}

function resolveApiKeyEnvDefault(args: {
  currentProvider: string;
  currentApiKeyEnvName?: string;
  nextProvider: string;
  preset: ProviderPreset;
}): string {
  if (args.currentProvider === args.nextProvider && args.currentApiKeyEnvName) {
    return args.currentApiKeyEnvName;
  }
  return args.preset.apiKeyEnvName ?? inferApiKeyEnvName(args.nextProvider);
}

function validateOptionalUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    new URL(trimmed);
    return undefined;
  } catch {
    return 'Base URL 必须是合法 URL，例如 https://api.example.com/v1';
  }
}

function printConfigPreview(config: {
  llm: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKeyEnvName?: string;
    apiKey?: string;
  };
  defaults: {
    packageScope?: string;
    publishTag: string;
    npmAccess: 'public' | 'restricted';
  };
}) {
  console.log('');
  console.log('将写入以下配置：');
  console.log(`- llm.provider: ${config.llm.provider}`);
  console.log(`- llm.model: ${config.llm.model}`);
  console.log(`- llm.baseUrl: ${config.llm.baseUrl ?? '(empty)'}`);
  if (config.llm.apiKey) {
    console.log(`- llm.apiKey: ${maskSecret(config.llm.apiKey)}`);
  } else {
    console.log(`- llm.apiKeyEnvName: ${config.llm.apiKeyEnvName ?? '(empty)'}`);
  }
  console.log(`- defaults.packageScope: ${config.defaults.packageScope ?? '(empty)'}`);
  console.log(`- defaults.publishTag: ${config.defaults.publishTag}`);
  console.log(`- defaults.npmAccess: ${config.defaults.npmAccess}`);
  console.log('');
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return '*'.repeat(secret.length);
  }
  return `${secret.slice(0, 4)}${'*'.repeat(Math.min(secret.length - 8, 20))}${secret.slice(-4)}`;
}

async function promptApiKey(args: {
  adapter: TuiAdapter;
  preset: ProviderPreset;
  currentProvider: string;
  currentApiKeyEnvName?: string;
  currentApiKey?: string;
  nextProvider: string;
}): Promise<{ apiKeyEnvName?: string; apiKey?: string }> {
  const { adapter, preset, currentProvider, currentApiKeyEnvName, currentApiKey, nextProvider } = args;

  if (preset.apiKeyOptional) {
    const mode = await adapter.select({
      message: 'API Key 配置方式',
      defaultValue: currentApiKey ? 'direct' : currentApiKeyEnvName ? 'env' : 'skip',
      choices: [
        { value: 'env', label: '环境变量', hint: '通过环境变量名读取 Key' },
        { value: 'direct', label: '直接输入 Key', hint: '将 Key 明文写入配置文件' },
        { value: 'skip', label: '跳过', hint: '该服务不需要 API Key' },
      ],
    });

    if (mode === 'skip') {
      return {};
    }

    if (mode === 'direct') {
      return promptDirectApiKey({ adapter, preset, currentProvider, currentApiKey, nextProvider });
    }

    return promptEnvApiKey({ adapter, preset, currentProvider, currentApiKeyEnvName, nextProvider });
  }

  const mode = await adapter.select({
    message: 'API Key 配置方式',
    defaultValue: currentApiKey ? 'direct' : 'env',
    choices: [
      { value: 'env', label: '环境变量', hint: `通过环境变量读取，${preset.apiKeyEnvHint}` },
      { value: 'direct', label: '直接输入 Key', hint: '将 Key 明文写入配置文件' },
    ],
  });

  if (mode === 'direct') {
    return promptDirectApiKey({ adapter, preset, currentProvider, currentApiKey, nextProvider });
  }

  return promptEnvApiKey({ adapter, preset, currentProvider, currentApiKeyEnvName, nextProvider });
}

async function promptDirectApiKey(args: {
  adapter: TuiAdapter;
  preset: ProviderPreset;
  currentProvider: string;
  currentApiKey?: string;
  nextProvider: string;
}): Promise<{ apiKey: string }> {
  const { adapter, preset, currentProvider, currentApiKey, nextProvider } = args;
  const defaultValue = currentProvider === nextProvider && currentApiKey ? currentApiKey : undefined;
  const apiKey = await adapter.input({
    message: `请输入 ${preset.label} API Key`,
    defaultValue,
    validate: (value) => (value.trim() ? undefined : 'API Key 不能为空。'),
  });
  return { apiKey: apiKey.trim() };
}

async function promptEnvApiKey(args: {
  adapter: TuiAdapter;
  preset: ProviderPreset;
  currentProvider: string;
  currentApiKeyEnvName?: string;
  nextProvider: string;
}): Promise<{ apiKeyEnvName: string }> {
  const { adapter, preset, currentProvider, currentApiKeyEnvName, nextProvider } = args;
  const apiKeyEnvName = await adapter.input({
    message: `请输入 API Key 环境变量名（${preset.apiKeyEnvHint}）`,
    defaultValue: resolveApiKeyEnvDefault({
      currentProvider,
      currentApiKeyEnvName,
      nextProvider,
      preset,
    }),
    validate: (value) => {
      if (!value.trim()) {
        return '环境变量名不能为空。';
      }
      return /^[A-Z_][A-Z0-9_]*$/i.test(value.trim()) ? undefined : '环境变量名只能包含字母、数字和下划线。';
    },
  });
  return { apiKeyEnvName: apiKeyEnvName.trim() };
}

function createCustomPreset(provider: string): ProviderPreset {
  return {
    value: provider,
    label: provider,
    hint: '自定义提供方',
    modelChoices: [],
    baseUrlHint: '请输入你的网关或代理地址',
    apiKeyEnvHint: '如无需密钥可留空',
    apiKeyOptional: true,
  };
}

function inferApiKeyEnvName(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'azure-openai':
      return 'AZURE_OPENAI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'deepseek':
      return 'DEEPSEEK_API_KEY';
    case 'qwen':
      return 'DASHSCOPE_API_KEY';
    case 'kimi':
      return 'MOONSHOT_API_KEY';
    case 'zhipu':
      return 'ZHIPUAI_API_KEY';
    case 'ollama':
      return '';
    case 'custom':
      return 'LLM_API_KEY';
    case 'openai':
    default:
      return 'OPENAI_API_KEY';
  }
}
