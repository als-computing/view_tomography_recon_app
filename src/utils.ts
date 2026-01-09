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
            console.warn("getTiledBaseUrl: VITE_API_TILED_URL (" + apiUrl + ") does not contain expected /api/v1/, using defaults instead.");
            const defaultUrl = createDefaultTiledBaseUrl();
            console.log("using default tiled base url:", defaultUrl);
            return defaultUrl;
        }
        return import.meta.env.VITE_API_TILED_URL;
    } else {
        return createDefaultTiledBaseUrl();
    }
};

export const createDefaultTiledBaseUrl = (): string => {
    const { protocol, hostname } = window.location;
    const port = import.meta.env.VITE_TILED_PORT ?? '8787';
    const apiPath = '/api/v1';
    return `${protocol}//${hostname}:${port}${apiPath}`;
};


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
