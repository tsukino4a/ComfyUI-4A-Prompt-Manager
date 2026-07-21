"""Stable public service interface for workflow-backed preview generation."""

from __future__ import annotations

try:
    from ..integrations.comfyui.workflow_analysis import (
        GenerationConfigError,
        InputBinding,
        WorkflowAnalysis,
        analyze_workflow,
    )
    from ..integrations.comfyui.workflow_prepare import prepare_workflow
    from .generation_settings import (
        DEFAULT_SETTINGS,
        MAX_WORKFLOW_BYTES,
        merged_settings,
        read_json_file,
        validate_settings,
        write_json_atomic,
    )
    from .preview_images import (
        PENDING_PREVIEW_MAX_AGE_SECONDS,
        PENDING_PREVIEW_SUBDIR,
        WEBP_METHOD,
        WEBP_QUALITY,
        attach_preview_image,
        cleanup_pending_previews,
        discard_pending_preview,
        finalize_image,
    )
except ImportError:  # standalone preview
    from integrations.comfyui.workflow_analysis import (  # type: ignore
        GenerationConfigError,
        InputBinding,
        WorkflowAnalysis,
        analyze_workflow,
    )
    from integrations.comfyui.workflow_prepare import prepare_workflow  # type: ignore
    from services.generation_settings import (  # type: ignore
        DEFAULT_SETTINGS,
        MAX_WORKFLOW_BYTES,
        merged_settings,
        read_json_file,
        validate_settings,
        write_json_atomic,
    )
    from services.preview_images import (  # type: ignore
        PENDING_PREVIEW_MAX_AGE_SECONDS,
        PENDING_PREVIEW_SUBDIR,
        WEBP_METHOD,
        WEBP_QUALITY,
        attach_preview_image,
        cleanup_pending_previews,
        discard_pending_preview,
        finalize_image,
    )


__all__ = [
    "DEFAULT_SETTINGS",
    "GenerationConfigError",
    "InputBinding",
    "MAX_WORKFLOW_BYTES",
    "PENDING_PREVIEW_MAX_AGE_SECONDS",
    "PENDING_PREVIEW_SUBDIR",
    "WEBP_METHOD",
    "WEBP_QUALITY",
    "WorkflowAnalysis",
    "analyze_workflow",
    "attach_preview_image",
    "cleanup_pending_previews",
    "discard_pending_preview",
    "finalize_image",
    "merged_settings",
    "prepare_workflow",
    "read_json_file",
    "validate_settings",
    "write_json_atomic",
]
