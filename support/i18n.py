from __future__ import annotations

from contextvars import ContextVar, Token
from string import Formatter


_LOCALE: ContextVar[str] = ContextVar("pm4a_locale", default="zh")
_EN_MESSAGES = {
    "正在准备": "Preparing",
    "正在处理": "Processing",
    "复制失败：{error}": "Copy failed: {error}",
    # Routes
    "4A 提示词管理器浏览器界面文件缺失": (
        "4A Prompt Manager browser UI file is missing"
    ),
    "保存失败：{error}": "Save failed: {error}",
    "创建失败：{error}": "Creation failed: {error}",
    "读取提示词库信息失败：{error}": (
        "Failed to read prompt library information: {error}"
    ),
    "刷新提示词库失败：{error}": "Failed to refresh prompt library: {error}",
    "读取提示词列表失败：{error}": "Failed to read prompt list: {error}",
    "读取提示词树失败：{error}": "Failed to read prompt tree: {error}",
    "创建文件夹失败：{error}": "Failed to create folder: {error}",
    "重命名文件夹失败：{error}": "Failed to rename folder: {error}",
    "操作失败：{error}": "Operation failed: {error}",
    "导出失败：{error}": "Export failed: {error}",
    "解析失败：{error}": "Parsing failed: {error}",
    "导入失败：{error}": "Import failed: {error}",
    "检测其他节点 Wildcards 失败：{error}": (
        "Failed to detect Wildcards from other nodes: {error}"
    ),
    "图片上传格式无效": "Invalid image upload format",
    "图片不能超过 32 MB": "Image cannot exceed 32 MB",
    "请选择图片": "Please select an image",
    "示例图保存失败：{error}": "Failed to save preview image: {error}",
    "收藏读取失败：{error}": "Failed to load favorites: {error}",
    "收藏保存失败：{error}": "Failed to save favorites: {error}",
    "NovelAI 权重转换失败：{error}": "NovelAI weight conversion failed: {error}",
    "读取提示词文件夹失败：{error}": "Failed to read prompt folder: {error}",
    "准备批量运行失败：{error}": "Failed to prepare batch run: {error}",
    "负面提示词为空，没有发送内容": "Negative prompt is empty; nothing was sent",
    "提示词为空，没有发送内容": "Prompt is empty; nothing was sent",
    "发送失败：{error}": "Send failed: {error}",
    "模型匹配失败：{error}": "Model matching failed: {error}",
    "读取生图设置失败：{error}": "Failed to load generation settings: {error}",
    "保存生图设置失败：{error}": "Failed to save generation settings: {error}",
    "请在运行中的 ComfyUI 内替换工作流": (
        "Replace the workflow from a running ComfyUI instance"
    ),
    "替换工作流失败：{error}": "Failed to replace workflow: {error}",
    "恢复默认工作流失败：{error}": "Failed to restore default workflow: {error}",
    "图片生成只能在运行中的 ComfyUI 内使用": (
        "Image generation is only available in a running ComfyUI instance"
    ),
    "请先在生图设置中选择模型": "Select a model in generation settings first",
    "准备工作流失败：{error}": "Failed to prepare workflow: {error}",
    "保存提示词示例图失败：{error}；预览图已保留，可重试挂接": (
        "Failed to save the prompt preview image: {error}; "
        "the generated preview was kept and can be attached again"
    ),
    "保存生成图片失败：{error}": "Failed to save generated image: {error}",
    "挂接生成图片失败：{error}": "Failed to attach generated image: {error}",
    "清理临时预览图失败：{error}": "Failed to clean up temporary preview: {error}",
    "单次批量生成不能超过 20000 条提示词": (
        "A batch cannot exceed 20,000 prompts"
    ),
    "Wildcard 卡片不能生成示例图": (
        "Wildcard cards cannot generate preview images"
    ),
    "读取批量生图范围失败：{error}": (
        "Failed to read batch generation scope: {error}"
    ),
    # Wildcard library
    "JSON 提示词无法读取：{filename} ({error})": (
        "Failed to read JSON prompt {filename} ({error})"
    ),
    "JSON 提示词必须是对象：{filename}": (
        "JSON prompt must be an object: {filename}"
    ),
    "content 必须是字符串：{filename}": "content must be a string: {filename}",
    "negative 必须是字符串：{filename}": "negative must be a string: {filename}",
    "note 必须是字符串：{filename}": "note must be a string: {filename}",
    "content 不能为空：{filename}": "content cannot be empty: {filename}",
    "标题不能为空": "Title cannot be empty",
    "标题不能超过 200 个字符": "Title cannot exceed 200 characters",
    "标题包含文件名不允许使用的字符": (
        "Title contains characters that are not allowed in filenames"
    ),
    "标题不能以空格或句点结尾": "Title cannot end with a space or period",
    "这个标题是系统保留名称": "This title is a reserved system name",
    "文件夹名称不能为空": "Folder name cannot be empty",
    "文件夹名称不能超过 200 个字符": "Folder name cannot exceed 200 characters",
    "文件夹名称包含系统不允许使用的字符": (
        "Folder name contains characters that are not allowed by the system"
    ),
    "文件夹名称不能以空格或句点结尾": (
        "Folder name cannot end with a space or period"
    ),
    "这个文件夹名称是系统保留名称": (
        "This folder name is a reserved system name"
    ),
    "保存文件夹不存在，请刷新后重试": (
        "The destination folder does not exist; refresh and try again"
    ),
    "保存文件夹超出提示词根目录": (
        "The destination folder is outside the prompt library root"
    ),
    "已存在同名文件夹：{name}": "A folder with the same name already exists: {name}",
    "根目录不能重命名": "The root folder cannot be renamed",
    "文件夹不存在，请刷新后重试": (
        "The folder does not exist; refresh and try again"
    ),
    "重命名后提示词键冲突：{key}": (
        "Prompt key conflicts after renaming: {key}"
    ),
    "提示词内容不能为空": "Prompt content cannot be empty",
    "已存在同名提示词：{name}": "A prompt with the same name already exists: {name}",
    "创建后无法重新读取提示词": "Could not reload the prompt after creating it",
    "正在整理提示词": "Organizing prompts",
    "正在整理自定义元数据": "Organizing custom metadata",
    "正在解析外部 Wildcard 文件": "Parsing external Wildcard files",
    "无法找到 ComfyUI custom_nodes 目录": (
        "Could not locate the ComfyUI custom_nodes directory"
    ),
    "外部 Wildcard 文件无效": "The external Wildcard file is invalid",
    "传统 TXT Wildcard 不存在": "The traditional TXT Wildcard does not exist",
    "提示词路径超出允许目录": "The prompt path is outside the allowed directory",
    "打开方式无效": "The open action is invalid",
    "打开传统 TXT Wildcard 失败：{error}": (
        "Failed to open the traditional TXT Wildcard: {error}"
    ),
    "第 {index} 条提示词的 metadata 必须是对象": (
        "metadata for prompt {index} must be an object"
    ),
    "第 {index} 条提示词的 favorite 必须是布尔值": (
        "favorite for prompt {index} must be a boolean"
    ),
    "第 {index} 条提示词必须是对象": "Prompt {index} must be an object",
    "第 {index} 条提示词的 content 必须是字符串": (
        "content for prompt {index} must be a string"
    ),
    "第 {index} 条提示词的 negative 必须是字符串": (
        "negative for prompt {index} must be a string"
    ),
    "第 {index} 条提示词的 note 必须是字符串": (
        "note for prompt {index} must be a string"
    ),
    "第 {index} 条提示词的 storage 无效": (
        "storage for prompt {index} is invalid"
    ),
    "第 {index} 条提示词必须声明 storage": (
        "prompt {index} must declare storage"
    ),
    "第 {index} 条 TXT Wildcard 不支持 negative 或 note": (
        "TXT Wildcard {index} does not support negative or note"
    ),
    "第 {index} 条提示词内容为空": "Prompt {index} has empty content",
    "第 {index} 条提示词缺少 relative_path 或 title": (
        "Prompt {index} is missing relative_path or title"
    ),
    "第 {index} 条提示词的相对路径无效": (
        "The relative path for prompt {index} is invalid"
    ),
    "不能导入到内部元数据目录": "Cannot import into the internal metadata directory",
    "source_type 必须是 txt 或 json": "source_type must be txt or json",
    "一次必须导入 1 到 {maximum} 条提示词": (
        "Each import must contain between 1 and {maximum} prompts"
    ),
    "导入的提示词文本总量过大": "The total imported prompt text is too large",
    "正在检查导入内容": "Checking import content",
    "正在写入提示词": "Writing prompts",
    "正在同步提示词索引": "Synchronizing prompt index",
    "正在恢复自定义元数据": "Restoring custom metadata",
    "不支持的操作": "Unsupported operation",
    "操作项目格式无效": "Invalid item format",
    "根目录不能删除、复制或移动": (
        "The root folder cannot be deleted, copied, or moved"
    ),
    "没有可操作的项目": "There are no items to operate on",
    "提示词不存在：{key}": "Prompt not found: {key}",
    "文件夹不存在：{key}": "Folder not found: {key}",
    "目标文件夹不能位于正在操作的文件夹内部": (
        "The destination cannot be inside a folder being operated on"
    ),
    "“{name}”已经在目标文件夹中": '"{name}" is already in the destination folder',
    "目标文件夹中已存在同名提示词：{name}": (
        "A prompt with the same name already exists in the destination: {name}"
    ),
    "目标文件夹中已存在同名文件夹：{name}": (
        "A folder with the same name already exists in the destination: {name}"
    ),
    "正在删除文件": "Deleting files",
    "正在复制文件": "Copying files",
    "正在移动文件": "Moving files",
    "正在同步自定义元数据": "Synchronizing custom metadata",
    "提示词不存在": "Prompt not found",
    "提示词库不存在": "Prompt library not found",
    "已存在同名提示词键：{key}": "A prompt with the same key already exists: {key}",
    "已存在但尚未载入的文件：{filename}，请先刷新提示词库": (
        "The file already exists but is not loaded: {filename}; "
        "refresh the prompt library first"
    ),
    "已存在同名文件：{filename}": "A file with the same name already exists: {filename}",
    "保存后无法重新读取提示词": "Could not reload the prompt after saving it",
    "没有可保存的修改": "There are no changes to save",
    "TXT Wildcard 内容只能使用外部文本编辑器修改": (
        "TXT Wildcard content can only be changed in an external text editor"
    ),
    "仅支持 PNG、JPG、WEBP 或 GIF 图片": (
        "Only PNG, JPG, WEBP, or GIF images are supported"
    ),
    # Scheduler
    "循环节点配置无法解析：{error}": "Could not parse scheduler configuration: {error}",
    "循环节点配置必须是对象": "Scheduler configuration must be an object",
    "栏目配置必须是数组": "Track configuration must be an array",
    "第 {index} 个栏目配置无效": "Track configuration {index} is invalid",
    "栏目 ID 不能重复": "Track IDs must be unique",
    "栏目“{name}”的循环模式无效": 'Track "{name}" has an invalid cycle mode',
    "栏目“{name}”的提示词配置无效": (
        'Track "{name}" has invalid prompt configuration'
    ),
    "固定负面提示词必须是字符串": "Fixed negative prompt must be a string",
    "起始位置和任务数量必须是整数": (
        "Start position and task count must be integers"
    ),
    "任务数量必须是整数": "Task count must be an integer",
    "任务数量至少为 1": "Task count must be at least 1",
    "栏目“{name}”中的文件夹通配符没有可用提示词：__{folder}__": (
        'The folder wildcard in track "{name}" has no available prompts: '
        "__{folder}__"
    ),
    "本轮提示词快照已失效，请重新点击批量运行": (
        "This prompt snapshot has expired; start the batch run again"
    ),
    "提示词文件夹为空": "The prompt folder is empty",
    "未知循环模式：{mode}": "Unknown cycle mode: {mode}",
    # Generation
    "api.json 必须是非空对象": "api.json must be a non-empty object",
    "节点 {node_id} 必须是对象": "Node {node_id} must be an object",
    "节点 {node_id} 缺少 class_type": "Node {node_id} is missing class_type",
    "节点 {node_id} 缺少 inputs": "Node {node_id} is missing inputs",
    "正面": "positive",
    "负面": "negative",
    "无法识别{label}提示词连接": "Could not identify the {label} prompt link",
    "无法找到{label}提示词文本输入": "Could not find the {label} prompt text input",
    "{label}提示词链包含多个文本节点，无法自动判断": (
        "The {label} prompt chain contains multiple text nodes and is ambiguous"
    ),
    "缺少节点：{nodes}": "Missing nodes: {nodes}",
    "工作流缺少可识别的图片输出节点": (
        "The workflow has no recognizable image output node"
    ),
    "工作流包含多个图片输出节点，请只保留一个最终输出": (
        "The workflow has multiple image output nodes; keep only one final output"
    ),
    "无法从图片输出反向找到采样器": (
        "Could not trace a sampler from the image output"
    ),
    "图片输出链包含多个采样器，无法自动判断": (
        "The image output chain contains multiple samplers and is ambiguous"
    ),
    "无法找到 ckpt_name 或 unet_name 模型输入": (
        "Could not find a ckpt_name or unet_name model input"
    ),
    "生成链包含多个模型加载输入，无法自动判断": (
        "The generation chain contains multiple model loader inputs and is ambiguous"
    ),
    "生成链包含多个 CLIP 加载输入，无法自动判断": (
        "The generation chain contains multiple CLIP loader inputs and is ambiguous"
    ),
    "生成链包含多个 VAE 加载输入，无法自动判断": (
        "The generation chain contains multiple VAE loader inputs and is ambiguous"
    ),
    "无法找到宽度输入": "Could not find the width input",
    "Latent 链包含多个宽高节点，无法自动判断": (
        "The latent chain contains multiple dimension nodes and is ambiguous"
    ),
    "无法找到高度输入": "Could not find the height input",
    "api.json 不能超过 4 MB": "api.json cannot exceed 4 MB",
    "无法读取 api.json：{error}": "Failed to read api.json: {error}",
    "api.json 顶层必须是对象": "The top level of api.json must be an object",
    "设置必须是对象": "Settings must be an object",
    "{key} 必须是字符串": "{key} must be a string",
    "选择的模型不存在": "The selected model does not exist",
    "选择的 CLIP 不存在": "The selected CLIP does not exist",
    "选择的 VAE 不存在": "The selected VAE does not exist",
    "选择的采样器无效": "The selected sampler is invalid",
    "选择的调度器无效": "The selected scheduler is invalid",
    "{key} 必须是整数": "{key} must be an integer",
    "宽度必须是 64–16384 之间的 8 的倍数": (
        "Width must be a multiple of 8 between 64 and 16384"
    ),
    "高度必须是 64–16384 之间的 8 的倍数": (
        "Height must be a multiple of 8 between 64 and 16384"
    ),
    "步数必须在 1–10000 之间": "Steps must be between 1 and 10000",
    "固定种子超出安全整数范围": "The fixed seed is outside the safe integer range",
    "{key} 必须是数字": "{key} must be a number",
    "CFG 必须在 0–100 之间": "CFG must be between 0 and 100",
    "降噪强度必须在 0–1 之间": "Denoise strength must be between 0 and 1",
    "种子模式必须是 random 或 fixed": "Seed mode must be random or fixed",
    "固定提示词文本过长": "Fixed prompt text is too long",
    "正面提示词不能为空": "Positive prompt cannot be empty",
    "负面提示词必须是字符串": "Negative prompt must be a string",
    "只允许读取本次任务的 output 或 temp 图片": (
        "Only output or temp images from this task may be read"
    ),
    "生成图片文件名无效": "Generated image filename is invalid",
    "生成图片路径越界": "Generated image path is outside the allowed directory",
    "生成图片不存在": "Generated image not found",
    "只允许使用临时预览图": "Only temporary preview images may be used",
    "临时预览图文件名无效": "Temporary preview filename is invalid",
    "临时预览图路径无效": "Temporary preview path is invalid",
    "临时预览图不存在": "Temporary preview image not found",
    "WebP 压缩结果校验失败": "WebP compression verification failed",
    # Model resolution, migration, and metadata
    "没有找到同名、Hash 或 Civitai 版本一致的本地模型": (
        "No local model matched the name, hash, or Civitai version"
    ),
    "没有找到同名模型，图片也没有可用的模型 Hash 或 Civitai 版本 ID": (
        "No model with the same name was found, and the image has no usable "
        "model hash or Civitai version ID"
    ),
    "提示词内容为空，无法转换：{path}": (
        "Prompt content is empty and cannot be converted: {path}"
    ),
    "提示词库不存在：{path}": "Prompt library not found: {path}",
    "备份校验失败：{path}": "Backup verification failed: {path}",
    "元数据文件无法读取：{path} ({error})": (
        "Failed to read metadata file {path} ({error})"
    ),
    "元数据文件格式无效：{path}": "Metadata file format is invalid: {path}",
    "不能备份提示词库之外的文件：{path}": (
        "Cannot back up a file outside the prompt library: {path}"
    ),
}
_FORMATTER = Formatter()


def _split_template(template: str) -> list[tuple[bool, str]]:
    parts: list[tuple[bool, str]] = []
    literal_start = 0
    index = 0
    while index < len(template):
        if template[index] == "{":
            if index + 1 < len(template) and template[index + 1] == "{":
                index += 2
                continue
            if literal_start < index:
                parts.append((False, template[literal_start:index]))
            depth = 1
            end = index + 1
            while end < len(template) and depth:
                if template[end] == "{":
                    depth += 1
                elif template[end] == "}":
                    depth -= 1
                end += 1
            if depth:
                raise ValueError("Single '{' encountered in format string")
            parts.append((True, template[index:end]))
            index = end
            literal_start = end
            continue
        if (
            template[index] == "}"
            and index + 1 < len(template)
            and template[index + 1] == "}"
        ):
            index += 2
            continue
        index += 1
    if literal_start < len(template):
        parts.append((False, template[literal_start:]))
    return parts


def _render_field(
    source: str, params: dict[str, object]
) -> tuple[str, bool]:
    _literal, field_name, format_spec, conversion = next(_FORMATTER.parse(source))
    if field_name is None:
        raise ValueError("Expected a replacement field")
    try:
        value, _used_key = _FORMATTER.get_field(field_name, (), params)
    except (AttributeError, IndexError, KeyError):
        return source, False
    rendered_spec, spec_complete = _format_template(format_spec, params)
    if not spec_complete:
        return source, False
    if conversion is not None:
        value = _FORMATTER.convert_field(value, conversion)
    return _FORMATTER.format_field(value, rendered_spec), True


def _format_template(
    template: str, params: dict[str, object]
) -> tuple[str, bool]:
    parts: list[str] = []
    complete = True
    for is_field, source in _split_template(template):
        if not is_field:
            parts.append(_FORMATTER.vformat(source, (), {}))
            continue
        rendered, field_complete = _render_field(source, params)
        parts.append(rendered)
        complete = complete and field_complete
    return "".join(parts), complete


def normalize_locale(value: object) -> str:
    if not isinstance(value, str):
        return "zh"
    locale = value.strip().casefold()
    return "en" if locale == "en" or locale.startswith("en-") else "zh"


def get_locale() -> str:
    return _LOCALE.get()


def set_locale(value: object) -> Token[str]:
    return _LOCALE.set(normalize_locale(value))


def reset_locale(token: Token[str]) -> None:
    _LOCALE.reset(token)


def tr(message: str, **params: object) -> str:
    template = _EN_MESSAGES.get(message, message) if get_locale() == "en" else message
    return _format_template(template, params)[0]
