# 最初のゴールを mise タスク名、残りのゴールをその引数として渡す。
#   make update  ->  mise run update
# `-` で始まるフラグは make に食われるので ARGS で渡す。
TASK := $(firstword $(MAKECMDGOALS))
TASK_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))

.PHONY: setup $(TASK) $(TASK_ARGS)

# ツールの導入だけここで行い、残りは mise タスク（.mise/tasks.toml）の setup に任せる。一覧: mise tasks
setup:
	@command -v mise >/dev/null 2>&1 || { echo "❌ mise が見つかりません: https://mise.jdx.dev/"; exit 1; }
	@mise trust -q
	@mise install
	@mise run setup

ifneq ($(TASK),)
ifneq ($(TASK),setup)
$(TASK):
	@mise run $(TASK) $(TASK_ARGS) $(ARGS)
endif
endif

# 引数として渡したゴールは何もしない
ifneq ($(TASK_ARGS),)
$(TASK_ARGS):
	@:
endif
