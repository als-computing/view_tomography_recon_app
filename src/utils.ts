import { TiledItemLinks } from "@blueskyproject/tiled";

export const createFileUrlFromTiledItem = (tiledItemData: TiledItemLinks): string | null => {
    let file_url = "";
    const { protocol, hostname } = window.location;
    const port = import.meta.env.VITE_TILED_PORT ?? '8787';
    const apiPath = '/api/v1/';
    //tiledItemData.default: "http://localhost:8000/api/v1/myZarrId"
    let fileId = tiledItemData.default?.split(apiPath)[1]; //grab the string after /api/v1/
    if (!fileId) {
        console.error("createFileUrlFromTiledItem: Unable to extract fileId from tiledItemData:", tiledItemData);
        return null;
    }
    file_url = `${protocol}//${hostname}:${port}/zarr/v2/${fileId}`;
     // file_url = `http://localhost:8787/zarr/v2/${fileId}`;
    return file_url;
};
