.PHONY: all install build clean link test

# Default target: install dependencies and build
all: install build

# Install dependencies
install:
	@echo "Installing dependencies..."
	npm install

# Build the project
build:
	@echo "Building the project..."
	npm run build

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf ./dist
	rm -rf ./node_modules

# Create symlink for local testing
link:
	@echo "Creating symlink for local testing..."
	npm link

# Full development setup (install, build, and link)
dev: install build link
	@echo "Development setup complete"

# Run tests if you have them
test:
	@echo "Running tests..."
	npm test
