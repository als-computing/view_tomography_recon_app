// Service Worker to intercept and log all network requests
// Note: Service workers intercept at the network level, not at the XMLHttpRequest/fetch API level

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const request = event.request;
  
  // Log detailed information about each network request
  console.log('🌐 Service Worker network request:', {
    url: url.toString(),
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    referrer: request.referrer,
    mode: request.mode,
    credentials: request.credentials,
    destination: request.destination,
    type: request.type || 'unknown'
  });
  
  // Check if the URL contains 'zarr'
  if (url.toString().includes('zarr')) {
    console.log('🎯 FOUND ZARR NETWORK REQUEST:', {
      url: url.toString(),
      method: request.method,
      referrer: request.referrer,
      userAgent: request.headers.get('User-Agent'),
      origin: request.headers.get('Origin'),
      authorization: request.headers.get('Authorization') ? 'Present' : 'Missing',
      allHeaders: Object.fromEntries(request.headers.entries())
    });
  }
  
  // Check for any tiled-related requests
  if (url.toString().includes('tiled') || url.hostname.includes('tiled')) {
    console.log('🔧 TILED-RELATED REQUEST:', {
      url: url.toString(),
      method: request.method,
      authorization: request.headers.get('Authorization') ? 'Present' : 'Missing'
    });
  }
  
  // Let the request proceed normally for now
  return;
});