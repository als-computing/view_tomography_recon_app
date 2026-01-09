import { TiledItemLinks } from "@blueskyproject/tiled";


/**
 * Creates a Zarr file URL from a Tiled item's data by converting the API URL format to Zarr format.
 * 
 * This function takes a Tiled item's API URL (containing '/api/v1/') and transforms it into 
 * a corresponding Zarr URL (using '/zarr/v2/') that can be consumed by itk-vtk-viewer.
 * 
 * @param tiledItemData - The Tiled item data containing link information
 * @param tiledItemData.default - The default API URL for the Tiled item
 * @returns The constructed Zarr file URL, or null if the URL cannot be constructed
 * 
 * @example
 * ```typescript
 * const tiledItem = { default: "http://localhost:8787/api/v1/my-dataset" };
 * const zarrUrl = createZarrFileUrlFromTiledItem(tiledItem);
 * // Returns: "http://localhost:8787/zarr/v2/my-dataset"
 * ```
 * 
 * @example
 * ```typescript
 * // Invalid input - missing /api/v1/
 * const invalidItem = { default: "http://localhost:8787/some-other-path" };
 * const result = createZarrFileUrlFromTiledItem(invalidItem);
 * // Returns: null
 * ```
 */
export const createZarrFileUrlFromTiledItem = (tiledItemData: TiledItemLinks): string | null => {
    // we need to pass the zarr file url to itk-vtk-viewer, but tiledItemData.default gives us the api url
    // strip out the api/v1/ portion and replace with zarr/v2/

    const tiledItemDefaultUrl = tiledItemData.default;
    //if the current url doesn't have api/v1/ in it, don't attempt to process the id at all
    //in future tiled viewer components, we will return an id field separately to eliminate these parsing issues
    if (!tiledItemDefaultUrl || !tiledItemDefaultUrl.includes('/api/v1')) {
        console.error("createZarrFileUrlFromTiledItem: Invalid tiledItemData.default URL does not contain expected /api/v1:", tiledItemDefaultUrl);
        return null;
    }

    const tiledBaseUrl = getTiledBaseUrl();
    const tiledBaseZarrUrl = tiledBaseUrl.replace('/api/v1', '/zarr/v2');
    const fileId = tiledItemDefaultUrl.split('/api/v1/')[1]; //grab the string after /api/v1/
    if (!fileId) {
        console.error("createFileUrlFromTiledItem: Unable to extract fileId from tiledItemData:", tiledItemData);
        return null;
    }
    const zarr_file_url = `${tiledBaseZarrUrl}/${fileId}`;

    return zarr_file_url;
};

/**
 * Gets the base URL for the Tiled API server.
 * 
 * This function returns the Tiled server's base URL, either from environment variables
 * or by constructing it from the current window location. The URL includes the '/api/v1' path.
 * 
 * @returns The base URL for the Tiled API server including the '/api/v1' path
 * 
 * @example
 * ```typescript
 * // With VITE_API_TILED_URL environment variable set
 * process.env.VITE_API_TILED_URL = "https://my-tiled-server.com/api/v1";
 * const baseUrl = getTiledBaseUrl();
 * // Returns: "https://my-tiled-server.com/api/v1"
 * ```
 * 
 * @example
 * ```typescript
 * // Without environment variable, constructs from current location
 * // Assuming current page is at https://localhost:3000/my-app
 * // and VITE_TILED_PORT is "8787"
 * const baseUrl = getTiledBaseUrl();
 * // Returns: "https://localhost:8787/api/v1"
 * ```
 * 
 * @remarks
 * The function prioritizes the VITE_TILED_BASE_URL environment variable if available.
 * If not set, it constructs the URL using:
 * - Current page's protocol and hostname
 * - VITE_TILED_PORT environment variable (defaults to '8787')
 * - '/api/v1' as the API path
 */
export const getTiledBaseUrl = (): string => {
    if (import.meta.env.VITE_API_TILED_URL) {
        const apiUrl = import.meta.env.VITE_API_TILED_URL;
        if (!apiUrl.includes('/api/v1')) {
            console.warn("getTiledBaseUrl: VITE_API_TILED_URL (" + apiUrl + ") does not contain expected /api/v1, using defaults instead.");
            const defaultUrl = createDefaultTiledBaseUrl();
            console.log("using default tiled base url:", defaultUrl);
            return defaultUrl;
        }
        const sanitizedUrl = sanitizeTiledBaseUrl(apiUrl);
        return sanitizedUrl;
    } else {
        return createDefaultTiledBaseUrl();
    }
};

/**
 * Creates the default Tiled base URL using the current window location and environment variables.
 * 
 * This function constructs a Tiled API URL by combining the current page's protocol and hostname
 * with a port number from environment variables. It's used as a fallback when no explicit
 * Tiled base URL is provided in the environment.
 * 
 * @returns The constructed default Tiled base URL including the '/api/v1' path
 * 
 * @example
 * ```typescript
 * // Assuming current page is at https://localhost:3000/my-app
 * // and VITE_TILED_PORT is "8787"
 * const defaultUrl = createDefaultTiledBaseUrl();
 * // Returns: "https://localhost:8787/api/v1"
 * ```
 * 
 * @example
 * ```typescript
 * // With no VITE_TILED_PORT set (uses default)
 * // Assuming current page is at http://example.com/app
 * const defaultUrl = createDefaultTiledBaseUrl();
 * // Returns: "http://example.com:8787/api/v1"
 * ```
 * 
 * @remarks
 * The function uses:
 * - Current window's protocol (http/https)
 * - Current window's hostname
 * - VITE_TILED_PORT environment variable (defaults to '8787' if not set)
 * - Fixed API path '/api/v1'
 */
export const createDefaultTiledBaseUrl = (): string => {
    const { protocol, hostname } = window.location;
    const port = import.meta.env.VITE_TILED_PORT ?? '8787';
    const apiPath = '/api/v1';
    return `${protocol}//${hostname}:${port}${apiPath}`;
};

/**
 * Sanitizes a Tiled base URL to ensure it has the correct format and API path.
 * 
 * This function normalizes a Tiled base URL by removing trailing slashes and ensuring
 * it ends with the proper '/api/v1' path. It's used to clean up URLs that may have
 * inconsistent formatting from environment variables or user input.
 * 
 * @param tiledBaseUrl - The Tiled base URL to sanitize
 * @returns The sanitized URL with trailing slashes removed and '/api/v1' path ensured
 * 
 * @example
 * ```typescript
 * // Remove trailing slash
 * const sanitized = sanitizeTiledBaseUrl("https://example.com/api/v1/");
 * // Returns: "https://example.com/api/v1"
 * ```
 * 
 * @example
 * ```typescript
 * // Add missing API path
 * const sanitized = sanitizeTiledBaseUrl("https://example.com");
 * // Returns: "https://example.com/api/v1"
 * ```
 * 
 * @example
 * ```typescript
 * // Already properly formatted
 * const sanitized = sanitizeTiledBaseUrl("https://example.com/api/v1");
 * // Returns: "https://example.com/api/v1"
 * ```
 * 
 * @remarks
 * This function performs two main operations:
 * 1. Removes any trailing slash from the URL
 * 2. Ensures the URL ends with '/api/v1' (appends it if missing)
 */
export const sanitizeTiledBaseUrl = (tiledBaseUrl: string): string => {
    let sanitizedUrl = tiledBaseUrl;
    // Remove trailing slash if present
    if (sanitizedUrl.endsWith('/')) {
        sanitizedUrl = sanitizedUrl.slice(0, -1);
    }
    // Ensure it ends with /api/v1
    if (!sanitizedUrl.endsWith('/api/v1')) {
        sanitizedUrl += '/api/v1';
    }
    return sanitizedUrl;
};

/**
 * Gets the default Zarr file URL from environment configuration.
 * 
 * This function constructs a default Zarr file URL using a file ID from environment variables.
 * It converts the Tiled API base URL to a Zarr URL format and appends the default file ID.
 * Returns null if no default file ID is configured.
 * 
 * @returns The constructed default Zarr file URL, or null if no default file ID is configured
 * 
 * @example
 * ```typescript
 * // With VITE_TILED_DEFAULT_FILE_ID set to "my-dataset"
 * const defaultUrl = getDefaultZarrFileUrl();
 * // Returns: "https://localhost:8787/zarr/v2/my-dataset"
 * ```
 * 
 * @example
 * ```typescript
 * // With no VITE_TILED_DEFAULT_FILE_ID set
 * const defaultUrl = getDefaultZarrFileUrl();
 * // Returns: null
 * ```
 * 
 * @remarks
 * This function:
 * 1. Reads the default file ID from VITE_TILED_DEFAULT_FILE_ID environment variable
 * 2. Gets the current Tiled base URL using getTiledBaseUrl()
 * 3. Converts the API URL format (/api/v1) to Zarr format (/zarr/v2)
 * 4. Appends the file ID to create the complete Zarr URL
 * 
 * @todo Search Tiled for the most recent zarr file (metadata contains "ngff:Image" value)
 * and use that file ID if no environment variable is set
 */
export const getDefaultZarrFileUrl = (): string | null => {
    // Get default file ID from env variable
    //TODO: search Tiled for the most recent zarr file (metadata contains "ngff:Image" value) and take that file ID if no env
    const defaultFileId = import.meta.env.VITE_TILED_DEFAULT_FILE_ID;
    if (!defaultFileId) {
        return null;
    } else {
        const tiledBaseUrl = getTiledBaseUrl();
        const tiledBaseZarrUrl = tiledBaseUrl.replace('/api/v1', '/zarr/v2');
        const zarr_file_url = `${tiledBaseZarrUrl}/${defaultFileId}`;
        return zarr_file_url;
    }
}
