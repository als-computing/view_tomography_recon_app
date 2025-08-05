FROM node:alpine3.21

RUN apk add --no-cache git

# Verify versions
RUN node --version && npm --version

# Puppeteer config to avoid Chromium downloads
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Clone itk-vtk-viewer
WORKDIR /tmp
RUN git clone -b vr https://github.com/davramov/itk-vtk-viewer.git

WORKDIR /tmp/itk-vtk-viewer

# Remove puppeteer dependency and build
RUN sed -i 's/"puppeteer":.*,//' package.json && \
    npm install && \
    npm run build && \
    npm link

EXPOSE 8083
CMD ["npx", "itk-vtk-viewer", "--port", "8083"]
