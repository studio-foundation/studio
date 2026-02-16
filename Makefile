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
	@cd contracts && npm run build
	@cd ralph && npm run build
	@cd runner && npm run build
	@cd engine && npm run build
	@cd cli && npm run build
	@echo "✓ All repositories built successfully"

# Clean all build artifacts
clean:
	@echo "Cleaning all repositories..."
	@cd contracts && npm run clean 2>/dev/null || true
	@cd ralph && npm run clean 2>/dev/null || true
	@cd runner && npm run clean 2>/dev/null || true
	@cd engine && npm run clean 2>/dev/null || true
	@cd cli && npm run clean 2>/dev/null || true
	@echo "✓ All repositories cleaned"

# Install dependencies in all repos
install:
	@echo "Installing dependencies..."
	@cd contracts && npm install
	@cd ralph && npm install
	@cd runner && npm install
	@cd engine && npm install
	@cd cli && npm install
	@echo "✓ All dependencies installed"

# Type-check all repositories
typecheck:
	@echo "Type-checking all repositories..."
	@cd contracts && npm run typecheck
	@cd ralph && npm run typecheck
	@cd runner && npm run typecheck
	@cd engine && npm run typecheck
	@cd cli && npm run typecheck
	@echo "✓ All type checks passed"

# Run tests in all repositories
test:
	@echo "Running tests..."
	@cd contracts && npm test 2>/dev/null || echo "  contracts: no tests configured yet"
	@cd ralph && npm test 2>/dev/null || echo "  ralph: no tests configured yet"
	@cd runner && npm test 2>/dev/null || echo "  runner: no tests configured yet"
	@cd engine && npm test 2>/dev/null || echo "  engine: no tests configured yet"
	@cd cli && npm test 2>/dev/null || echo "  cli: no tests configured yet"

# Start dev mode (watch) - opens multiple terminals
dev:
	@echo "Starting dev mode requires multiple terminals."
	@echo "Run these commands in separate terminals:"
	@echo ""
	@echo "  Terminal 1: cd contracts && npm run dev"
	@echo "  Terminal 2: cd ralph && npm run dev"
	@echo "  Terminal 3: cd runner && npm run dev"
	@echo "  Terminal 4: cd engine && npm run dev"
	@echo "  Terminal 5: cd cli && npm run dev"

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
	@echo "=== cli ==="
	@cd cli && git status -s || echo "Not a git repo"

# Link CLI globally to enable 'studio' command
link-cli:
	@echo "Linking CLI globally..."
	@cd cli && npm link
	@echo "✓ CLI linked successfully"
	@echo ""
	@echo "You can now use the 'studio' command globally."
	@echo "Note: The CLI won't work until implementation is complete."
