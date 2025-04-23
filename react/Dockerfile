FROM continuumio/miniconda3:25.1.1-2

# Install system dependencies
RUN apt-get update && \
    apt-get install -y git curl build-essential socat && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install app and viewer dependency
WORKDIR /app
COPY . .

# Puppeteer skip (redundant but safe for good DX)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install project dependencies
WORKDIR /app
RUN npm install bluesky-web && npm install

RUN echo '#!/usr/bin/env node\n\
const fs = require("fs");\n\
const path = require("path");\n\
\n\
const packageJsonPath = path.join("node_modules", "bluesky-web", "package.json");\n\
\n\
if (fs.existsSync(packageJsonPath)) {\n\
    console.log("Fixing bluesky-web package.json...");\n\
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));\n\
    \n\
    if (packageJson.exports && packageJson.exports["./style.css"] && !packageJson.exports["./dist/bluesky-web.css"]) {\n\
        packageJson.exports["./dist/bluesky-web.css"] = "./dist/bluesky-web.css";\n\
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));\n\
        console.log("Successfully added missing export to bluesky-web package.json");\n\
    } else {\n\
        console.log("Package already has the required exports or structure is different than expected");\n\
    }\n\
} else {\n\
    console.log("bluesky-web package.json not found at", packageJsonPath);\n\
}\n' > fix-bluesky.cjs && chmod +x fix-bluesky.cjs

# Run the fix script
RUN node fix-bluesky.cjs

EXPOSE 5174
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5174"]
