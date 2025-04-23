FROM continuumio/miniconda3:25.1.1-2

# Install system dependencies and Node.js 20.x
RUN apt-get update && \
    apt-get install -y git curl build-essential socat && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify versions
RUN node --version && npm --version

# Puppeteer config to avoid Chromium downloads
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Clone itk-vtk-viewer
WORKDIR /tmp
RUN git clone -b iframe https://github.com/als-computing/itk-vtk-viewer.git

# Update package.json to use newer vtk.js version with better mobile support
WORKDIR /tmp/itk-vtk-viewer
RUN sed -i 's/"@kitware\/vtk.js": "\^29.4.6"/"@kitware\/vtk.js": "32.14.0"/g' package.json && \
    sed -i 's/"vtk.js": "\^29.4.6"/"vtk.js": "32.14.0"/g' package.json

# Remove puppeteer dependency and build
RUN sed -i 's/"puppeteer":.*,//' package.json && \
    npm install && \
    npm run build && \
    npm link


EXPOSE 8082
CMD ["npx", "itk-vtk-viewer", "--port", "8082"]
