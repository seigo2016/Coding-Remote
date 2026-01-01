FROM node:22-slim AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Install build dependencies for node-pty
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN pnpm build

# Production stage
FROM node:22-slim

WORKDIR /app

RUN corepack enable

# Install runtime dependencies for node-pty
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install production deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/hooks ./hooks

# Create non-root user
RUN useradd -m -s /bin/bash claude
USER claude

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
