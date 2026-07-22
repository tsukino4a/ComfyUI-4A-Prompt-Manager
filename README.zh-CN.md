# ComfyUI-4A-Prompt-Manager

[English](README.md)

中文视频介绍（Bilibili）：https://www.bilibili.com/video/BV1DWKv6NE6t

面向 ComfyUI 的文件夹提示词库与调度器：浏览/编辑 Wildcard、多轨拼装提示词、从图片元数据回填参数，并保存带便携参数的生成结果。

![总览](docs/images/hero.png)

## 亮点

### 完整易用的提示词管理前端

侧栏库界面，提示词按普通文件夹结构保存（JSON 卡片 + TXT Wildcard），复制文件夹即可备份/分享；随意导入导出；可为卡片生成预览图（内置 API 工作流，也可替换成你自己的 `api.json`）。

![Browser](docs/images/browser.png)

### 多层 Prompt Scheduler

多轨正面拼装，支持随机 / 顺序 / 洗牌；兼容 Impact 风格 Wildcard 解析（`__key__`、`{a|b}`、权重、多选、文件夹与全局文件名引用）；每个栏位还可从外部连入 STRING。

![Scheduler](docs/images/scheduler.png)

### 元数据复用（Meta Loader / Meta Apply）

兼容常见图片格式。可从前端节点、系统外部或 ComfyUI 资产任意拖入图片；一键复用嵌入的提示词、推理参数与 LoRA（LoRA 回填需安装 [Lora Manager](https://github.com/willmiao/ComfyUI-Lora-Manager)）。

![Meta Apply](docs/images/meta_apply.png)

### Input Parameters & Image Saver

连线简单，输出采样与分辨率参数；按 A1111 风格写入 PNG/JPEG/WebP 元数据，方便保存并复用你的提示词与参数（JPEG/WebP 需要 `piexif`）。

![Input Parameters / Image Saver](docs/images/input_saver.png)

## 安装

### ComfyUI-Manager（推荐）

搜索 **4A Prompt Manager** / `ComfyUI-4A-Prompt-Manager` 安装。Manager 会处理 `requirements.txt` / `install.py`。

### 手动安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/tsukino4a/ComfyUI-4A-Prompt-Manager.git ComfyUI-4A-Prompt-Manager
cd ComfyUI-4A-Prompt-Manager
python install.py
# 或: pip install -r requirements.txt
```

安装后重启 ComfyUI。

## 快速开始

1. 打开 **工作流 → 浏览模板 → ComfyUI-4A-Prompt-Manager**，可试用：
   - `01_single_sampler_workflow` — Input Parameters → KSampler → Image Saver
   - `02_double_sampler_workflow` — Double Sample Parameters + 二次采样
2. 打开 **Prompt Manager Browser**（或顶栏入口）。应能看到自带示例目录 `wildcards/examples/`（JSON 卡片 + TXT）。
3. 了解 **批量导入**：使用 [`examples/pm4a_examples_bundle.json`](examples/pm4a_examples_bundle.json)。这是库「导出」同款的 `pm4a-prompt-bundle`（混合 `json` 与 `txt`）。在 Browser 导入对话框中导入即可；**不要**把该文件放进 `wildcards/`（它不是单条提示词卡片）。

## 节点一览

| 节点 | 作用 |
|------|------|
| Prompt Manager Browser | 节点内完整提示词库 UI |
| Prompt Scheduler | 按栏目拼装正/负面字符串 |
| Meta Loader (Prompt Display) | 查看图片元数据卡片；有 Lora Manager 时可应用 LoRA 文本 |
| Meta Apply | 自动把图片元数据应用到目标（含经 Lora Manager 的 LoRA） |
| Input Parameters | seed / steps / cfg / sampler / 尺寸 + JSON |
| Double Sample Parameters | 二次采样参数 JSON |
| Image Saver | 保存图片与 hash / A1111 参数 |

## 示例工作流与提示词样例

| 路径 | 用途 |
|------|------|
| [`example_workflows/`](example_workflows/) | **浏览模板**用的 UI 工作流（含同名 `.png` 预览图） |
| [`wildcards/examples/`](wildcards/examples/) | 随包装的提示词样例（会被库加载） |
| [`examples/pm4a_examples_bundle.json`](examples/pm4a_examples_bundle.json) | 导出/导入格式演示 |
| [`workflows/default_api.json`](workflows/default_api.json) | 浏览器预览生图用的内置 UNet API 图（可替换） |

若模板里加载器为空或模型名在你本机不存在，运行前请先选好模型。

## 依赖

- **额外依赖：** [`piexif`](https://pypi.org/project/piexif/)（`>=1.1.3`），用于 Image Saver / 预览图的 JPEG·WebP EXIF
- Pillow、NumPy、aiohttp 由 ComfyUI 提供

未安装 `piexif` 时：PNG 仍可保存；JPEG/WebP 写元数据会报错（预览 WebP 可能静默跳过 EXIF）。

## 许可证

本项目以 [MIT License](LICENSE) 发布。

Image Saver 部分逻辑改编自 [ComfyUI-Image-Saver](https://github.com/alexopus/ComfyUI-Image-Saver)，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
