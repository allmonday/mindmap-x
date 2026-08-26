"""Agent CLI 入口 —— Claude Code / Codex 在 bash 里直接调用。

用法示例（子命令为下划线风格）：
    uv run python -m src.cli mindmap-service list_maps
    uv run python -m src.cli mindmap-service get_tree --map-id 1
    uv run python -m src.cli mindmap-service add_node --map-id 1 --parent-id 2 --content "新想法"
    uv run python -m src.cli mindmap-service apply_outline --map-id 1 --outline "- [id:1] 根\\n  - 新分支"
"""
from nexusx import UseCaseAppConfig, create_use_case_cli
from src.service.mindmap.service import MindmapService

use_case_config = UseCaseAppConfig(
    name="mindmap",
    services=[MindmapService],
    description="人 + Agent 协同脑图：读写同一棵树",
)

cli = create_use_case_cli(use_case_config)

if __name__ == "__main__":
    cli()
