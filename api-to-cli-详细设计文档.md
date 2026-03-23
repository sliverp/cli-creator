# `@cli-creator` 详细设计文档

## 1. 文档目标

本文档用于定义一个高扩展性的 `api-to-cli` 工具方案：

- 输入某个 API 的文档、SDK 或说明材料
- 输出一套可直接执行的 CLI 工具
- 同时提供统一的 CLI 管理工具用于安装、升级、测试、发布和运维

结合你的要求，本文重点解决以下问题：

1. 如何把结构化 API 文档稳定转换为 CLI
2. 如何为非结构化文档提供 AI 解析入口
3. 如何保证命令语言统一、帮助信息完整
4. 如何实现安全的密钥管理
5. 如何支持后续扩展更多服务、更多 action、更多 provider
6. 如何支持一键测试、全局安装、PATH 可执行
7. 如何提供 `clix` 这样的统一管理能力

---

## 2. 需求摘要

### 2.1 目标场景

用户给出任意一种输入源：

- OpenAPI / Swagger / Postman Collection / JSON Schema 等结构化描述
- 厂商 API 文档片段
- SDK 代码
- Markdown / HTML / PDF / Wiki 等非结构化文档

系统输出：

- 一个或一组可执行 CLI 工具
- 自动生成命令参数、帮助说明、示例、测试代码
- 支持认证、升级、配置管理、安装到 PATH
- 支持用 `clix` 统一管理这些 CLI

### 2.2 典型示例

输入文档片段：

```http
POST / HTTP/1.1
Host: cdb.tencentcloudapi.com
Content-Type: application/json
X-TC-Action: StartCpuExpand
<公共请求参数>

{
  "InstanceId": "cdb-himitj11",
  "Type": "manual",
  "ExpandCpu": 4
}
```

输出命令：

```bash
tencentcloud cdb StartCpuExpand --InstanceId cdb-himitj11 --Type manual --ExpandCpu 4
```

### 2.3 核心要求

1. 高扩展性
2. 对结构化文档优先使用非 AI 解析
3. 对非结构化文档提供 AI 解析能力
4. 统一 CLI 设计语言
5. 每个命令都支持 `--help` / `-h`
6. 具备安全的密钥管理系统
7. 支持增量扩展 provider / service / action
8. 支持一键单元测试
9. 支持安装到 PATH，全局可执行
10. 提供 `clix` 作为统一管理面板

---

## 3. 设计原则

### 3.1 结构化优先，AI 兜底

- **结构化输入**：走规则解析器，不依赖 AI
- **半结构化输入**：走规则解析器 + 校验器
- **非结构化输入**：走 AI 提取 + 人工确认 + 标准化模型落盘

原则：**AI 只负责“提取”，不能直接负责“发布”**。最终必须落到统一的标准模型后才能生成 CLI。

### 3.2 统一命令语法

管理类命令与执行类命令采用统一语言风格：

- 管理动作统一使用：`list`、`get`、`import`、`build`、`test`、`install`、`update`、`remove`、`doctor`
- 执行动作保留原始 API Action 名称，以保证对厂商接口的可映射性

即：

- 平台管理：`clix install tencentcloud`
- Provider 运行：`tencentcloud cdb StartCpuExpand ...`

### 3.3 生成与运行分离

系统分成两层：

1. **生成层**：把文档/SDK 转成 CLI 工程或插件包
2. **运行层**：CLI 命令执行时，统一处理参数、认证、签名、请求发送、输出格式化

这样可以保证：

- 解析器与运行时解耦
- 支持不同厂商接入同一个运行时
- 支持后续做“按需生成”与“动态加载”

### 3.4 插件化优先

所有能力都通过插件扩展：

- 文档解析插件
- SDK 解析插件
- Provider 运行时插件
- 认证插件
- 输出格式插件
- 测试插件
- 打包插件

### 3.5 安全默认开启

密钥、Token、签名配置、Profile 等均采用“默认安全”模式：

- 默认不明文落盘
- 默认支持操作系统密钥环
- 默认对日志脱敏
- 默认支持最小权限与多 profile

---

## 4. 总体产品形态

`@cli-creator` 建议拆成两类用户可见产品：

### 4.1 管理 CLI：`clix`

职责：

- 导入 API 文档 / SDK
- 生成 CLI 工程
- 构建、测试、安装、升级 Provider CLI
- 管理已安装 Provider
- 管理模板、插件、缓存和 registry

示例：

```bash
clix import doc ./tencentcloud-cdb-openapi.json --provider tencentcloud
clix import sdk ./sdk/tencentcloud-go --provider tencentcloud
clix build tencentcloud
clix test tencentcloud
clix install tencentcloud
clix list
clix update tencentcloud
```

### 4.2 业务 CLI：如 `tencentcloud`

职责：

- 面向最终用户执行 API 调用
- 暴露 service + action 风格的命令
- 管理认证、默认地域、Profile、输出格式
- 提供 `--help`、`--example`、`--dry-run` 等能力

示例：

```bash
tencentcloud cdb StartCpuExpand --InstanceId cdb-himitj11 --Type manual --ExpandCpu 4
tencentcloud auth list
tencentcloud config set --region ap-guangzhou
tencentcloud service list
tencentcloud action list cdb
```

---

## 5. 推荐技术选型

## 5.1 首选方案：`TypeScript + Node.js`

推荐原因：

1. CLI 生态成熟：`commander`、`oclif`、`yargs` 等方案成熟
2. 适合做代码生成与模板渲染
3. 天然适合 npm 发布与全局安装
4. 易于封装跨平台 PATH、Shell Completion、插件加载
5. 易于接入 AI、HTTP、AST、文档解析、加密库

### 5.2 关键依赖建议

- CLI 框架：`oclif` 或 `commander`
- 参数 schema：`zod`
- HTTP：`undici` 或 `axios`
- 模板引擎：`ejs` / `handlebars`
- 文档解析：`swagger-parser`、`openapi-types`、`typescript` compiler API
- 安全存储：`keytar`
- 测试：`vitest`
- 打包：`tsup`
- Shell completion：CLI 框架原生能力或自定义生成

### 5.3 为什么不优先选 Go

Go 也非常适合 CLI，但第一期若重点是：

- 文档解析器丰富度
- npm 全局分发
- 插件生态灵活性
- AI 流程与模板驱动生成

则 TypeScript 的研发效率更高。

结论：

- **一期建议：TypeScript / Node.js**
- **二期可评估将 Runtime Core 下沉为 Go 或 Rust，提高性能与分发独立性**

---

## 6. 系统总体架构

```text
+-----------------------+
|      输入源层         |
| OpenAPI / SDK / MD    |
| HTML / PDF / Wiki     |
+-----------+-----------+
            |
            v
+-----------------------+
|      解析适配层       |
| Structured Parsers    |
| AI Extractors         |
+-----------+-----------+
            |
            v
+-----------------------+
|   标准模型 Canonical  |
| Provider / Service    |
| Action / Params       |
| Auth / Example        |
+-----------+-----------+
            |
            v
+-----------------------+
|      代码生成层       |
| CLI Commands          |
| Help / Tests / Docs   |
+-----------+-----------+
            |
            v
+-----------------------+
|      运行时核心       |
| Parse / Auth / Sign   |
| HTTP / Output         |
+-----------+-----------+
            |
            v
+-----------------------+
|      打包与管理层     |
| clix / Registry       |
| Install / Update      |
+-----------------------+
```

---

## 7. 核心模块拆分

建议采用 Monorepo：

```text
@cli-creator/
  packages/
    clix/                    # 管理 CLI
    core/                    # 标准模型、公共类型、错误体系
    runtime/                 # 运行时内核
    parser-openapi/          # OpenAPI 解析器
    parser-sdk-ts/           # TS SDK 解析器
    parser-sdk-go/           # Go SDK 解析器
    parser-markdown/         # Markdown/HTML 半结构化解析
    parser-ai/               # AI 提取插件
    generator-cli/           # CLI 代码生成器
    generator-tests/         # 测试生成器
    security/                # 密钥管理与加密
    registry/                # Provider 安装/版本管理
    plugin-api/              # 插件接口定义
    provider-tencentcloud/   # 已生成/内置的腾讯云 provider
```

### 7.1 `core`

职责：

- 定义标准 Canonical Spec
- 定义插件接口
- 定义日志、错误码、元数据模型
- 定义命令命名规范与校验器

### 7.2 `runtime`

职责：

- 命令参数解析
- 参数校验
- 认证读取
- 请求签名
- 请求发送
- 响应格式化
- 错误处理

### 7.3 `parser-*`

职责：

- 将不同输入源解析成统一 Canonical Spec
- 标记字段可信度
- 提供冲突与缺失报告

### 7.4 `generator-cli`

职责：

- 根据 Canonical Spec 生成 CLI 命令定义
- 生成 `--help`、示例、自动补全、别名、错误提示
- 生成 Provider 入口程序

### 7.5 `generator-tests`

职责：

- 生成参数校验测试
- 生成请求构造测试
- 生成快照测试
- 生成 provider 级健康检查

### 7.6 `security`

职责：

- Secret 存储与读取
- Profile 管理
- 密钥加密
- 日志脱敏
- 签名插件对接

### 7.7 `registry`

职责：

- 管理已安装 provider
- 管理版本和升级
- 管理本地缓存
- 管理生成物与发布包索引

---

## 8. 标准模型设计（Canonical Spec）

所有解析器必须输出统一结构，不允许直接从原始文档生成 CLI。

### 8.1 顶层结构

```ts
interface CanonicalSpec {
  provider: ProviderMeta;
  services: ServiceSpec[];
  auth: AuthSpec[];
  examples?: ExampleSpec[];
  sourceMeta: SourceMeta;
}
```

### 8.2 ProviderMeta

```ts
interface ProviderMeta {
  name: string;           // tencentcloud
  displayName: string;    // Tencent Cloud
  version: string;
  defaultHostStyle?: 'service-subdomain' | 'fixed-host' | 'custom';
  packageName?: string;   // @cli-creator/provider-tencentcloud
}
```

### 8.3 ServiceSpec

```ts
interface ServiceSpec {
  name: string;           // cdb
  host?: string;          // cdb.tencentcloudapi.com
  version?: string;
  actions: ActionSpec[];
}
```

### 8.4 ActionSpec

```ts
interface ActionSpec {
  name: string;                 // StartCpuExpand
  method: 'GET' | 'POST';
  path: string;
  description?: string;
  params: ParamSpec[];
  headers?: HeaderSpec[];
  response?: ResponseSpec;
  authRef?: string;
  examples?: ExampleSpec[];
  idempotent?: boolean;
}
```

### 8.5 ParamSpec

```ts
interface ParamSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  description?: string;
  enum?: string[];
  defaultValue?: unknown;
  location: 'query' | 'path' | 'header' | 'body';
}
```

### 8.6 AI 提取附加字段

```ts
interface ConfidenceMeta {
  score: number;
  source: 'rule' | 'ai' | 'merged';
  needReview: boolean;
}
```

对于 AI 解析得到的字段，需要额外记录：

- 可信度分数
- 来源片段
- 是否需要人工确认

---

## 9. 输入解析策略

## 9.1 结构化输入：严格规则解析

适用：

- OpenAPI / Swagger
- Postman Collection
- JSON Schema
- 官方 SDK 中具备稳定元数据的代码

处理流程：

1. 识别输入类型
2. 调用对应解析器
3. 转为 Canonical Spec
4. 执行 schema 校验
5. 输出解析报告

特点：

- 不依赖 AI
- 结果可复现
- 便于回归测试

### 9.2 半结构化输入：规则 + 模式提取

适用：

- 有固定格式的 Markdown 文档
- HTTP 示例块
- 参数表格
- 返回示例 JSON

处理流程：

1. 抽取 HTTP 方法、Host、Action、Body
2. 识别参数表与公共请求头
3. 与内置模式库匹配
4. 生成初版 Canonical Spec
5. 对缺失项输出告警

### 9.3 非结构化输入：AI 提取

适用：

- 纯文字说明
- 混合截图、段落、示例碎片
- 缺乏标准 schema 的 Wiki/文档

处理流程：

1. 文档预处理（分段、去噪、代码块识别）
2. 提取候选 action / 参数 / 示例 / 错误码
3. 产出结构化 JSON 草案
4. 进入校验器补齐缺失字段
5. 输出 `needReview=true` 的审查项
6. 由用户确认后再生成 CLI

### 9.4 AI 友好入口设计

建议提供统一命令：

```bash
clix import doc ./api.md --provider tencentcloud --mode strict
clix import doc ./api.md --provider tencentcloud --mode hybrid
clix import doc ./api.md --provider tencentcloud --mode ai
```

模式定义：

- `strict`：只允许规则解析，遇到不确定内容直接失败
- `hybrid`：规则优先，缺失字段用 AI 补齐
- `ai`：允许直接走 AI 提取，再进行结构校验

这样既保证可控性，也保留 AI 入口。

### 9.5 非结构化文档导入方案

这一块建议不要理解成“直接把一篇 Markdown/PDF 丢给 AI，然后直接吐出 CLI”。

正确做法应拆成 **导入、预处理、提取、审查、固化** 五步。

#### 第一步：统一导入入口

无论输入来自哪里，入口命令都统一成 `clix import doc`，只是 source 不同：

```bash
clix import doc ./api.md --provider tencentcloud --service cdb --mode ai
clix import doc ./api.html --provider tencentcloud --service cdb --mode ai
clix import doc ./api.pdf --provider tencentcloud --service cdb --mode ai
clix import doc https://example.com/api/start-cpu-expand --provider tencentcloud --service cdb --mode ai
cat ./api.txt | clix import doc --stdin --provider tencentcloud --service cdb --mode ai
```

也就是说，**导入层只负责把内容读进来，不负责理解业务语义**。

导入层建议支持三类 source adapter：

1. `file`：本地文件，如 `.md`、`.html`、`.pdf`、`.txt`
2. `url`：网页、Wiki、公开文档链接
3. `stdin`：适合管道输入，便于和爬虫、抓取脚本联动

#### 第二步：先做文档标准化，不直接进 AI

非结构化文档最大的问题不是“没有 AI”，而是“原始噪音太多”。

所以导入后先做标准化预处理，产出一个中间文档模型 `NormalizedDocument`：

```ts
interface NormalizedDocument {
  title?: string;
  sourceType: 'file' | 'url' | 'stdin';
  contentType: 'markdown' | 'html' | 'pdf' | 'text';
  sections: SectionBlock[];
  codeBlocks: CodeBlock[];
  tables: TableBlock[];
  metadata: Record<string, string>;
}
```

预处理要做这些事情：

1. 去导航栏、页脚、广告、版权噪音
2. 保留标题层级和段落结构
3. 抽取代码块、HTTP 示例块、JSON 示例块
4. 抽取参数表格
5. 抽取类似 `Host`、`Action`、`Method`、`Path` 这种强信号字段
6. 按章节切块，避免一次性喂给 AI 过长上下文

结论是：**AI 不直接看原始文档，而是看标准化后的块数据**。

#### 第三步：按“强信号优先”提取，不做全文自由生成

这里不要让 AI 自由发挥，而是把任务拆成多个小提取器：

1. `EndpointExtractor`：提取 `host`、`path`、`method`
2. `ActionExtractor`：提取 action 名、描述、服务名
3. `ParamExtractor`：提取参数名、类型、是否必填、枚举值
4. `AuthExtractor`：提取鉴权方式、公共请求头、签名要求
5. `ExampleExtractor`：提取请求示例、返回示例、错误码示例

提取策略：

- 优先使用规则匹配代码块、表格、标题
- 规则拿不到的字段，再调用 AI 补齐
- AI 的输出必须是受限 JSON，不允许直接输出自然语言 spec

建议把 AI 输出约束为：

```json
{
  "service": "cdb",
  "action": "StartCpuExpand",
  "method": "POST",
  "host": "cdb.tencentcloudapi.com",
  "path": "/",
  "params": [],
  "examples": [],
  "confidence": 0.92,
  "evidence": []
}
```

其中 `evidence` 要记录来源片段，后面审查时必须能回溯。

#### 第四步：进入审查态，而不是直接生成 CLI

对非结构化导入，第一次产物不应该是 CLI，而应该是一个“待确认 spec 草案”。

建议输出到：

```text
.spec-workspace/
  imports/
    tencentcloud/
      cdb/
        StartCpuExpand.draft.json
        StartCpuExpand.review.json
```

其中：

- `draft.json`：提取后的原始草案
- `review.json`：带有缺失项、冲突项、置信度的审查结果

审查项至少包括：

1. 缺少 method / host / path
2. 参数类型不明确
3. 是否必填不明确
4. 服务名与 host 推断冲突
5. 示例与参数表不一致
6. 鉴权方式不明确

建议提供配套命令：

```bash
clix import review tencentcloud cdb StartCpuExpand
clix import approve tencentcloud cdb StartCpuExpand
clix import reject tencentcloud cdb StartCpuExpand
```

也就是：**先导入成 draft，再 review，再 approve，最后 build**。

#### 第五步：批准后再固化为 Canonical Spec

只有 `approve` 之后，才把 draft 转成正式 spec：

```bash
clix import approve tencentcloud cdb StartCpuExpand
clix build tencentcloud
```

固化时做三件事：

1. 写入正式 Canonical Spec
2. 生成 provider 命令元数据
3. 触发自动测试模板生成

这样可以确保：

- AI 只参与理解，不直接参与发布
- 后面同一个 action 再升级时可以做 diff
- 审查记录可以沉淀，便于回归

### 9.6 非结构化文档导入的命令设计

建议首期就把命令定清楚：

```bash
clix import doc <source> --provider <name> --service <name> --mode ai
clix import review <provider> <service> <action>
clix import approve <provider> <service> <action>
clix import reject <provider> <service> <action>
clix import list --status draft
```

补充参数建议：

```bash
--source-type file|url|stdin
--content-type auto|markdown|html|pdf|text
--entry '# StartCpuExpand'
--chunk-size 4000
--max-chunks 20
--lang zh|en|auto
--output-dir .spec-workspace
```

说明：

- `--entry`：当一篇文档很长时，只从指定章节开始抽取
- `--chunk-size`：控制切块大小
- `--max-chunks`：避免长文档导入成本失控
- `--output-dir`：让草案目录可控

### 9.7 首期建议支持的非结构化格式

首期不要一次支持所有格式，建议按价值排序：

1. `Markdown`
2. `HTML`
3. `纯文本`
4. `PDF`

原因：

- Markdown/HTML 最容易保留结构
- 纯文本最容易做规则提取
- PDF 的解析误差最大，建议第一期仅作为补充输入

### 9.8 一个完整例子

```bash
clix import doc ./docs/cdb-start-cpu-expand.md --provider tencentcloud --service cdb --mode ai
clix import review tencentcloud cdb StartCpuExpand
clix import approve tencentcloud cdb StartCpuExpand
clix build tencentcloud
clix test tencentcloud --service cdb --action StartCpuExpand
```

这条链路里，真正“解决非结构化导入”的关键不是 AI 本身，而是：

1. 统一入口
2. 文档标准化
3. 强信号抽取
4. draft/review/approve 三段式流程
5. 最终固化到 Canonical Spec

---

## 10. 代码生成设计

## 10.1 生成目标

每个 Provider CLI 至少生成以下内容：

```text
provider/
  src/
    commands/
      cdb/
        StartCpuExpand.ts
        StopCpuExpand.ts
      auth/
      config/
      service/
    index.ts
  tests/
  package.json
```

### 10.2 生成内容

1. 命令定义文件
2. 参数 schema
3. `--help` 文案
4. 命令使用示例
5. Shell completion
6. 单元测试
7. Provider 元信息清单
8. 安装脚本与入口 bin

### 10.3 生成策略

建议采用：

- **模板 + 元数据驱动生成**，而不是直接拼字符串
- 所有模板基于 Canonical Spec 渲染
- 模板版本可升级
- 支持 Provider 自定义模板覆盖

### 10.4 是否直接生成每个 action 的独立代码

建议：**生成命令元数据 + 少量薄包装代码**，尽量减少重复代码。

原因：

- 如果 action 数量很大，完全生成代码会膨胀
- 更好的方式是：运行时统一执行，生成层只生成命令元数据与注册信息

即：

- `StartCpuExpand.ts` 可以非常薄
- 真正的请求构造由 `runtime` 统一完成

---

## 11. 运行时设计

运行时是整个系统可扩展性的核心。

### 11.1 运行时职责

- 从命令行解析参数
- 把参数绑定到 Canonical Spec
- 读取当前 profile / region / output
- 调用 provider 认证与签名器
- 组装 HTTP 请求
- 发送请求
- 输出 JSON / table / yaml

### 11.2 统一执行流程

```text
命令输入
 -> 命令元数据加载
 -> 参数解析与校验
 -> 认证信息加载
 -> 请求构造
 -> Provider 签名
 -> HTTP 调用
 -> 响应解析
 -> 标准输出
```

### 11.3 输出格式

建议统一支持：

- `--output json`
- `--output yaml`
- `--output table`
- `--query`（筛选输出字段，后续可扩展）

### 11.4 运行时增强能力

建议内建：

- `--dry-run`：只打印将发送的请求，不实际执行
- `--debug`：输出调试信息（自动脱敏）
- `--profile`：指定认证配置
- `--region`：指定地域
- `--timeout`：请求超时
- `--endpoint`：覆盖默认 endpoint
- `--retry`：重试次数

---

## 12. CLI 命令设计规范

## 12.1 两类命令空间

### 管理 CLI：`clix`

```bash
clix init
clix import
clix build
clix test
clix install
clix list
clix update
clix remove
clix doctor
clix registry list
```

### Provider CLI：`tencentcloud`

```bash
tencentcloud auth set
tencentcloud auth list
tencentcloud config set
tencentcloud config get
tencentcloud service list
tencentcloud action list cdb
tencentcloud cdb StartCpuExpand --InstanceId xxx
```

## 12.2 统一语言约束

为了避免出现“`xxx run` / `xxx start` / `xxx exec` 混用”的问题，建议约束：

1. 管理动作统一使用固定动词集合
2. 业务动作直接沿用 API 官方 Action 名
3. 配置动作统一使用 `set/get/list/remove`
4. 安装升级统一使用 `install/update/remove`
5. 健康检查统一使用 `doctor`

## 12.3 帮助系统

所有命令自动具备：

```bash
-h
--help
--example
```

帮助信息至少包含：

- 命令说明
- 参数说明
- 必填项
- 默认值
- 认证要求
- 使用示例
- 输出示例
- 常见错误提示

示例：

```bash
tencentcloud cdb StartCpuExpand --help
```

帮助中建议展示：

```text
Usage:
  tencentcloud cdb StartCpuExpand --InstanceId <string> --Type <string> --ExpandCpu <number>

Options:
  --InstanceId   实例 ID（必填）
  --Type         扩容类型（必填）
  --ExpandCpu    扩容 CPU 数（必填）
  --profile      使用的认证配置
  --region       地域
  --output       输出格式，默认 json
  -h, --help     查看帮助
  --example      查看示例
```

---

## 13. 认证与密钥管理设计

这是本项目的关键模块之一。

## 13.1 设计目标

- 安全存储 SecretId / SecretKey / Token
- 支持多 provider、多 profile
- 支持系统密钥环与文件加密双模式
- 支持环境变量覆盖
- 支持日志脱敏

## 13.2 存储分层

建议按优先级读取：

1. 命令行显式参数
2. 环境变量
3. 当前 profile
4. 默认 profile
5. 交互式获取（后续可选）

### 13.3 存储方式

#### 优先方案：系统密钥环

- macOS Keychain
- Windows Credential Manager
- Linux Secret Service

Node 可通过 `keytar` 统一接入。

#### 兜底方案：本地加密文件

当系统密钥环不可用时：

- 将密钥存储在本地加密文件
- 使用主密码派生密钥进行 AES-GCM 加密
- 文件权限强制收紧

### 13.4 本地配置建议拆分

非敏感配置：

```text
~/.clix/config.json
```

敏感配置：

```text
系统密钥环
或
~/.clix/secrets.enc
```

### 13.5 建议命令

```bash
tencentcloud auth set --profile default
tencentcloud auth list
tencentcloud auth remove --profile default
tencentcloud auth use --profile prod
```

### 13.6 安全要求

1. 不允许默认明文保存 SecretKey
2. 所有调试日志必须脱敏
3. 支持 profile 隔离
4. 支持临时 Token
5. 支持 CI 场景的环境变量注入
6. 后续支持 STS / AssumeRole

---

## 14. Provider 扩展机制

你的要求里最重要的是：

- 现在支持 `tencentcloud cdb`
- 后续支持 `tencentcloud cbs`
- 再后续支持新的 Action，如 `StopCpuExpand`

因此必须做到 **Provider / Service / Action 三层可增量扩展**。

## 14.1 扩展层次

### Provider 级扩展

例如：

- `tencentcloud`
- `aws`
- `aliyun`
- `internal-platform`

### Service 级扩展

例如 `tencentcloud` 下：

- `cdb`
- `cbs`
- `cvm`

### Action 级扩展

例如 `cdb` 下：

- `StartCpuExpand`
- `StopCpuExpand`
- `DescribeInstances`

## 14.2 增量更新方式

建议将 provider 清单定义为版本化 spec：

```text
provider-spec/
  tencentcloud/
    v1/
      cdb.json
      cbs.json
```

新增 service 或 action 时：

1. 导入新文档或 SDK
2. 生成新的 Canonical Spec
3. 与旧 spec 做 diff
4. 只增量生成受影响命令
5. 自动补充/更新测试

### 14.3 `clix` 管理动作

```bash
clix install tencentcloud
clix update tencentcloud
clix list
clix remove tencentcloud
clix diff tencentcloud --from 1.0.0 --to 1.1.0
```

---

## 15. 一键测试设计

## 15.1 测试目标

- 确保解析结果正确
- 确保命令参数正确
- 确保请求构造正确
- 确保签名接入正确
- 确保帮助文案完整

## 15.2 测试分层

### A. 解析器测试

输入固定文档，断言输出 Canonical Spec。

### B. 生成器测试

生成 CLI 元数据，进行快照比对。

### C. 运行时测试

断言命令行参数能正确映射成 HTTP 请求。

### D. Provider 契约测试

与官方示例或 mock server 做比对。

### E. 帮助系统测试

断言每个命令都支持 `-h` / `--help` / `--example`。

## 15.3 一键命令

```bash
clix test tencentcloud
clix test tencentcloud --service cdb
clix test tencentcloud --action StartCpuExpand
```

### 15.4 建议生成的测试内容

- 参数必填校验测试
- enum 合法值测试
- body 构造测试
- header 构造测试
- 请求签名测试
- 响应解析测试
- CLI 帮助快照测试

---

## 16. 安装与 PATH 设计

## 16.1 全局安装方案

建议通过 npm 全局安装：

```bash
npm install -g @cli-creator/clix
npm install -g @cli-creator/provider-tencentcloud
```

或者通过 `clix` 代理安装：

```bash
clix install tencentcloud
```

`clix` 内部完成：

1. 下载 provider 包
2. 安装到全局目录或用户目录
3. 生成可执行 shim
4. 校验 PATH

## 16.2 PATH 检查命令

```bash
clix doctor
```

至少检查：

- Node / npm 是否可用
- 全局 bin 目录是否在 PATH
- provider 可执行文件是否存在
- 密钥环能力是否可用

## 16.3 后续可选分发方式

- npm 全局包
- 单文件二进制（后续）
- Homebrew（后续）
- 内部软件源（后续）

---

## 17. `clix` 管理能力设计

`clix` 不是简单脚手架，而是整个生态的控制面。

## 17.1 基础命令

```bash
clix list
clix install tencentcloud
clix update tencentcloud
clix remove tencentcloud
clix doctor
```

## 17.2 生成相关命令

```bash
clix import doc ./api.md --provider tencentcloud
clix import sdk ./sdk/tencentcloud-go --provider tencentcloud
clix build tencentcloud
clix test tencentcloud
```

## 17.3 版本管理命令

```bash
clix versions tencentcloud
clix diff tencentcloud --from 1.0.0 --to 1.1.0
clix pin tencentcloud --version 1.0.0
```

## 17.4 插件管理命令

```bash
clix plugin list
clix plugin install @cli-creator/parser-openapi
clix plugin remove @cli-creator/parser-ai
```

---

## 18. `tencentcloud` Provider 首期落地方案

建议第一期只做一个最小但完整闭环：

### 18.1 MVP 范围

- Provider：`tencentcloud`
- Service：`cdb`
- Actions：
  - `StartCpuExpand`
  - `StopCpuExpand`（可选，若文档齐全则一起做）
- 认证：SecretId / SecretKey / Token
- 输出：JSON
- 帮助：`-h` / `--help` / `--example`
- 管理：`clix install/list/test`

### 18.2 为什么先做这个范围

因为它能验证完整链路：

1. 文档导入
2. 结构化抽取
3. Canonical Spec 落盘
4. 命令生成
5. 认证签名
6. 请求执行
7. 帮助文案生成
8. 单元测试生成
9. 安装到 PATH

只要这一条链路打通，后续加 `cbs` 或其他 action 基本就是增量扩展。

---

## 19. 关键数据流示例

## 19.1 从文档到命令

```text
原始文档
 -> 解析器识别 Host=cdb.tencentcloudapi.com
 -> 解析器识别 Action=StartCpuExpand
 -> 解析器识别 Body 参数
 -> 输出 Canonical Spec
 -> 生成命令元数据
 -> 注册到 tencentcloud/cdb/StartCpuExpand
 -> CLI 可执行
```

## 19.2 Canonical Spec 示例

```json
{
  "provider": {
    "name": "tencentcloud",
    "displayName": "Tencent Cloud",
    "version": "1.0.0"
  },
  "services": [
    {
      "name": "cdb",
      "host": "cdb.tencentcloudapi.com",
      "actions": [
        {
          "name": "StartCpuExpand",
          "method": "POST",
          "path": "/",
          "params": [
            { "name": "InstanceId", "type": "string", "required": true, "location": "body" },
            { "name": "Type", "type": "string", "required": true, "location": "body" },
            { "name": "ExpandCpu", "type": "number", "required": true, "location": "body" }
          ]
        }
      ]
    }
  ]
}
```

## 19.3 对应 CLI 命令

```bash
tencentcloud cdb StartCpuExpand --InstanceId cdb-himitj11 --Type manual --ExpandCpu 4
```

---

## 20. 错误处理设计

建议统一错误层级：

1. `InputError`：输入文件不合法
2. `ParseError`：解析失败
3. `SpecValidationError`：标准模型校验失败
4. `GenerationError`：代码生成失败
5. `AuthError`：认证配置错误
6. `RequestError`：请求失败
7. `ProviderError`：厂商接口返回异常

CLI 输出要求：

- 错误信息要短
- 默认用户可读
- `--debug` 时再输出细节
- 绝不能泄露敏感凭证

---

## 21. 可观测性设计

建议从第一期就纳入：

- 结构化日志
- 调试日志脱敏
- 命令执行耗时
- 解析成功率
- 生成成功率
- 帮助命令命中率（后续可选）

注意：

- 默认不采集敏感业务数据
- 默认不开启远程遥测
- 若后续要加 telemetry，必须允许用户显式关闭/开启

---

## 22. 版本与升级策略

## 22.1 三层版本

建议分别维护：

1. `clix` 版本
2. Runtime Core 版本
3. Provider Spec / Provider Package 版本

### 22.2 升级命令

```bash
clix update
clix update tencentcloud
```

### 22.3 升级原则

- Provider 升级优先兼容老命令
- Action 删除需要给出废弃告警
- 重大变化通过 `clix diff` 告知用户

---

## 23. 项目分阶段实施建议

## Phase 1：闭环验证版

目标：把 `tencentcloud cdb StartCpuExpand` 跑通。

交付内容：

- `clix`
- Canonical Spec
- OpenAPI/HTTP 示例解析器
- `tencentcloud` provider runtime
- `auth` 能力
- 单元测试
- 全局安装

## Phase 2：可扩展版

目标：支持 `cdb` 多 action，新增 `cbs` 服务。

交付内容：

- 增量更新能力
- `clix update/diff`
- 更多模板
- 更多测试样板

## Phase 3：AI 增强版

目标：支持非结构化文档接入。

交付内容：

- `parser-ai`
- `strict/hybrid/ai` 模式
- AI 审核清单
- 可追溯来源片段

## Phase 4：生态化版

目标：支持多 provider、多发布方式、多插件市场。

交付内容：

- provider registry
- 插件市场
- 单文件二进制
- 内部/外部包分发

---

## 24. 风险与应对

## 24.1 文档质量不稳定

风险：不同 API 文档格式差异极大。

应对：

- 以 Canonical Spec 为中间层
- 解析结果必须可审查
- AI 结果不能直接发布

## 24.2 生成代码膨胀

风险：action 太多时命令文件爆炸。

应对：

- 生成元数据，减少重复代码
- 使用统一 runtime 执行

## 24.3 凭证安全风险

风险：密钥被误打印或明文保存。

应对：

- 默认接入密钥环
- 所有日志脱敏
- 文件存储必须加密

## 24.4 升级破坏兼容性

风险：新文档覆盖旧命令。

应对：

- diff 后再发布
- 版本化 spec
- 废弃策略与兼容期

---

## 25. 建议的首期目录结构

```text
cli-creator/
  packages/
    clix/
    core/
    runtime/
    parser-openapi/
    parser-markdown/
    parser-ai/
    generator-cli/
    generator-tests/
    security/
    provider-tencentcloud/
  examples/
    tencentcloud/
      cdb-start-cpu-expand.json
  specs/
    tencentcloud/
      cdb/
        StartCpuExpand.spec.json
```

---

## 26. 建议的首期最小命令清单

## 26.1 `clix`

```bash
clix import doc <path> --provider <name>
clix build <provider>
clix test <provider>
clix install <provider>
clix list
clix update <provider>
clix doctor
```

## 26.2 `tencentcloud`

```bash
tencentcloud auth set
tencentcloud auth list
tencentcloud config set
tencentcloud service list
tencentcloud action list cdb
tencentcloud cdb StartCpuExpand
tencentcloud cdb StopCpuExpand
```

---

## 27. 结论

`@cli-creator` 最合适的实现路线是：

1. **以 TypeScript + Node.js 作为一期技术栈**
2. **以 Canonical Spec 作为唯一中间标准层**
3. **以 `clix` 作为生态控制面，以 `tencentcloud` 作为业务执行面**
4. **结构化解析优先，AI 只做补充和提取**
5. **统一命令语言，帮助系统自动生成**
6. **通过 Provider / Service / Action 三层增量扩展**
7. **通过安全密钥管理、版本化 spec、自动测试保证可持续演进**

如果按落地优先级排序，建议下一步直接进入：

1. 定义 Canonical Spec
2. 定义 `clix` 与 `tencentcloud` 的命令清单
3. 先接入 `tencentcloud cdb StartCpuExpand`
4. 跑通导入、生成、安装、执行、测试闭环

---

## 28. 下一步建议

建议你下一轮直接做以下三件事之一：

### 方案 A：先定技术架构
我来继续把这份文档拆成：

- 包结构
- TypeScript 接口定义
- 命令树设计
- 模块依赖图

### 方案 B：先定 Canonical Spec
我直接输出第一版 `spec schema`，后面代码就按这个 schema 开发。

### 方案 C：先做 MVP 实施方案
我直接把 MVP 拆成开发任务清单：

- 第 1 周做什么
- 第 2 周做什么
- 每个包要写哪些文件
- 命令先实现哪些

如果你愿意，我下一步建议直接继续出：`@cli-creator` 的“目录结构 + package 划分 + 命令树 + spec schema”。
