.PHONY: help build clean install test typecheck dev status

# Default target
help:
	@echo "Studio v7 Workspace - Available Commands"
	@echo ""
	@echo "  make build      - Build all repositories"
	@echo "  make clean      - Clean all build artifacts"
	@echo "  make install    - Install dependencies in all repos"
	@echo "  make typecheck  - Type-check all repositories"
	@echo "  make test       - Run tests in all repositories"
	@echo "  make dev        - Start dev mode (watch) in all repos"
	@echo "  make status     - Show git status for all repos"
	@echo "  make link-cli   - Link CLI globally (enables 'studio' command)"
	@echo ""

# Build all repositories in dependency order
build:
	@echo "Building all repositories..."
	@pnpm build
	@echo "✓ All repositories built successfully"

# Clean all build artifacts
clean:
	@echo "Cleaning all repositories..."
	@pnpm -r run clean 2>/dev/null || true
	@echo "✓ All repositories cleaned"

# Install dependencies in all repos
install:
	@echo "Installing dependencies..."
	@pnpm install
	@echo "✓ All dependencies installed"

# Type-check all repositories
typecheck:
	@echo "Type-checking all repositories..."
	@pnpm -r run typecheck
	@echo "✓ All type checks passed"

# Run tests in all repositories
test:
	@echo "Running tests..."
	@pnpm -r run test 2>/dev/null || true

# Start dev mode (watch) - opens multiple terminals
dev:
	@echo "Starting dev mode requires multiple terminals."
	@echo "Run these commands in separate terminals:"
	@echo ""
	@echo "  Terminal 1: cd contracts && pnpm run dev"
	@echo "  Terminal 2: cd ralph && pnpm run dev"
	@echo "  Terminal 3: cd runner && pnpm run dev"
	@echo "  Terminal 4: cd engine && pnpm run dev"
	@echo "  Terminal 5: cd cli && pnpm run dev"

# Show git status for all repos
status:
	@echo "Git Status for all repositories:"
	@echo ""
	@echo "=== contracts ==="
	@cd contracts && git status -s || echo "Not a git repo"
	@echo ""
	@echo "=== ralph ==="
	@cd ralph && git status -s || echo "Not a git repo"
	@echo ""
	@echo "=== runner ==="
	@cd runner && git status -s || echo "Not a git repo"
	@echo ""
	@echo "=== engine ==="
	@cd engine && git status -s || echo "Not a git repo"
	@echo ""
	@echo "=== api ==="
	@cd api && git status -s || echo "Not a git repo"
	@echo ""
	@echo "=== cli ==="
	@cd cli && git status -s || echo "Not a git repo"
	@echo ""
	@echo "=== anonymizer ==="
	@cd anonymizer && git status -s || echo "Not a git repo"
	@echo ""	


# Link CLI globally to enable 'studio' command
link-cli:
	@echo "Linking CLI globally..."
	@cd cli && pnpm link --global
	@echo "✓ CLI linked successfully"
	@echo ""
	@echo "You can now use the 'studio' command globally."
	@echo "Note: The CLI won't work until implementation is complete."
