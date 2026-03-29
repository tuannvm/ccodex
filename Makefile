.PHONY: help build lint format clean publish test all

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

build: ## Build TypeScript
	npm run build

lint: ## Run ESLint
	npm run lint

format: ## Format code with Prettier
	npm run format

format-check: ## Check code formatting
	npm run format:check

clean: ## Clean build artifacts
	rm -rf dist

test: ## Run tests (placeholder)
	@echo "No tests configured yet"

publish: lint build ## Lint, build, then publish to npm
	npm publish --access public

all: format lint build ## Format, lint, and build
	@echo "✓ All checks passed"
