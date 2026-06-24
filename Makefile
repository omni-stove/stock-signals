DEV_VARS := worker/.dev.vars
DEV_VARS_EXAMPLE := worker/.dev.vars.example

.PHONY: setup
setup:
	@command -v mise >/dev/null 2>&1 || { echo "❌ mise が見つかりません: https://mise.jdx.dev/"; exit 1; }
	mise install
	mise exec -- pnpm install
	@if [ -f $(DEV_VARS) ]; then \
		echo "⏭  $(DEV_VARS) は既に存在"; \
	else \
		cp $(DEV_VARS_EXAMPLE) $(DEV_VARS); \
		echo "📝 $(DEV_VARS) を作成。実値を埋める"; \
	fi
