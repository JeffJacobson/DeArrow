import { VideoID } from "@ajayyy/maze-utils/lib/video";
import { ThumbnailResult, ThumbnailSubmission } from "./thumbnails/thumbnailData";
import { TitleResult, TitleSubmission } from "./titles/titleData";
import { FetchResponse, sendRealRequestToCustomServer, sendRequestToCustomServer } from "@ajayyy/maze-utils/lib/background-request-proxy";
import { BrandingResult, updateBrandingForVideo } from "./videoBranding/videoBranding";
import { logError } from "./utils/logger";
import { getHash } from "@ajayyy/maze-utils/lib/hash";
import Config from "./config";
import { generateUserID } from "@ajayyy/maze-utils/lib/setup";
import { BrandingUUID } from "./videoBranding/videoBranding";
import { timeoutPomise } from "@ajayyy/maze-utils";
import { isCachedThumbnailLoaded, setupPreRenderedThumbnail } from "./thumbnails/thumbnailRenderer";

interface VideoBrandingCacheRecord extends BrandingResult {
    lastUsed: number;
}

interface ActiveThumbnailCacheRequestInfo {
    shouldRerequest: boolean;
    time?: number;
    generateNow?: boolean;
}

const cache: Record<VideoID, VideoBrandingCacheRecord> = {};
const cacheLimit = 1000;

const activeRequests: Record<VideoID, Promise<Record<VideoID, BrandingResult> | null>> = {};
const activeThumbnailCacheRequests: Record<VideoID, ActiveThumbnailCacheRequestInfo> = {};

export async function getVideoThumbnailIncludingUnsubmitted(videoID: VideoID, queryByHash: boolean): Promise<ThumbnailResult | null> {
    const unsubmitted = Config.local!.unsubmitted[videoID]?.thumbnails?.find(t => t.selected);
    if (unsubmitted) {
        return {
            ...unsubmitted,
            votes: 0,
            locked: false,
            UUID: generateUserID() as BrandingUUID
        };
    }

    const result = (await getVideoBranding(videoID, queryByHash))?.thumbnails[0];
    if (!result || (!result.locked && result.votes < 0)) {
        return null;
    } else {
        return result;
    }
}

export async function getVideoTitleIncludingUnsubmitted(videoID: VideoID, queryByHash: boolean): Promise<TitleResult | null> {
    const unsubmitted = Config.local?.unsubmitted?.[videoID]?.titles?.find(t => t.selected);
    if (unsubmitted) {
        return {
            ...unsubmitted,
            votes: 0,
            locked: false,
            UUID: generateUserID() as BrandingUUID,
            original: false
        };
    }

    const result = (await getVideoBranding(videoID, queryByHash))?.titles[0];
    if (!result || (!result.locked && result.votes < 0)) {
        return null;
    } else {
        return result;
    }
}

export async function getVideoBranding(videoID: VideoID, queryByHash: boolean): Promise<VideoBrandingCacheRecord | null> {
    const cachedValue = cache[videoID];

    if (cachedValue) {
        return cachedValue;
    }

    activeRequests[videoID] ??= (() => {
        const results = fetchBranding(queryByHash, videoID);
        const thumbnailCacheResults = fetchBrandingFromThumbnailCache(videoID);

        const handleResults = (results: Record<VideoID, BrandingResult>) => {
            for (const [key, result] of Object.entries(results)) {
                cache[key] = {
                    titles: result.titles,
                    thumbnails: result.thumbnails,
                    lastUsed: key === videoID ? Date.now() : cache[key]?.lastUsed ?? 0
                };
            }
    
            const keys = Object.keys(cache);
            if (keys.length > cacheLimit) {
                const numberToDelete = keys.length - cacheLimit;
    
                for (let i = 0; i < numberToDelete; i++) {
                    const oldestKey = keys.reduce((a, b) => cache[a].lastUsed < cache[b].lastUsed ? a : b);
                    delete cache[oldestKey];
                }
            }
        };

        let mainFetchDone = false;
        let thumbnailCacheFetchDone = false;
        results.then((results) => {
            mainFetchDone = true;

            if (results) {
                const oldResults = cache[videoID];
                handleResults(results);

                if (thumbnailCacheFetchDone) {
                    updateBrandingForVideo(videoID).catch(logError);
                }

                const thumbnail = results[videoID].thumbnails[0];
                const title = results[videoID].titles[0];
                // Fetch for a cached thumbnail if it is either not loaded yet, or has an out of date title
                if (thumbnail && !thumbnail.original 
                        && (!isCachedThumbnailLoaded(videoID, thumbnail.timestamp) || (title?.title && oldResults?.titles?.length <= 0))) {
                    queueThumbnailCacheRequest(videoID, thumbnail.timestamp, title?.title);
                }
            }
        }).catch(logError);

        thumbnailCacheResults.then((results) => {
            thumbnailCacheFetchDone = true;

            if (results) {
                if (!mainFetchDone) {
                    handleResults(results);
                }
            }
        }).catch(logError);


        return Promise.race([results, thumbnailCacheResults]);
    })();
    activeRequests[videoID].catch(() => delete activeRequests[videoID]);

    try {
        await Promise.race([timeoutPomise(Config.config?.fetchTimeout), activeRequests[videoID]]);
        delete activeRequests[videoID];
    
        return cache[videoID];
    } catch (e) {
        logError(e);
        return null;
    }
}

async function fetchBranding(queryByHash: boolean, videoID: VideoID): Promise<Record<VideoID, BrandingResult> | null> {
    let results: Record<VideoID, BrandingResult> | null = null;
    
    if (queryByHash) {
        const request = await sendRequestToServer("GET", `/api/branding/${(await getHash(videoID, 1)).slice(0, 4)}`);

        if (request.ok || request.status === 404) {
            try {
                const json = JSON.parse(request.responseText);
                results = json;
            } catch (e) {
                logError(`Getting video branding for ${videoID} failed: ${e}`);
            }
        }
    } else {
        const request = await sendRequestToServer("GET", "/api/branding", {
            videoID
        });

        if (request.ok || request.status === 404) {
            try {
                results = {
                    [videoID]: JSON.parse(request.responseText)
                };
            } catch (e) {
                logError(`Getting video branding for ${videoID} failed: ${e}`);
            }
        }
    }
    return results;
}

async function fetchBrandingFromThumbnailCache(videoID: VideoID, time?: number, title?: string, generateNow?: boolean, reRequesting = false): Promise<Record<VideoID, BrandingResult> | null> {
    activeThumbnailCacheRequests[videoID] ??= {
        shouldRerequest: false
    };
    const request = await sendRequestToThumbnailCache(videoID, time, title, generateNow);

    if (request.status === 200) {
        try {
            const timestamp = parseFloat(request.headers.get("x-timestamp") as string);
            const title = request.headers.get("x-title");
            if (isNaN(timestamp)) {
                logError(`Getting video branding from cache server for ${videoID} failed: Timestamp is NaN`);
                return null;
            }

            if (activeThumbnailCacheRequests[videoID].shouldRerequest 
                    && activeThumbnailCacheRequests[videoID].time !== timestamp
                    && !reRequesting) {
                // Stop and refetch with the proper timestamp
                return handleThumbnailCacheRefetch(videoID, time);
            }

            await setupPreRenderedThumbnail(videoID, timestamp, await request.blob());

            delete activeThumbnailCacheRequests[videoID];
            return {
                [videoID]: {
                    titles: title ? [{
                        votes: 0,
                        locked: false,
                        UUID: generateUserID() as BrandingUUID,
                        original: false,
                        title: title
                    }] : [],
                    thumbnails: [{
                        votes: 0,
                        locked: false,
                        UUID: generateUserID() as BrandingUUID,
                        original: false,
                        timestamp
                    }]
                }
            };
        } catch (e) {
            logError(`Getting video branding for ${videoID} failed: ${e}`);
        }
    } else if (activeThumbnailCacheRequests[videoID].shouldRerequest && !reRequesting) {
        return handleThumbnailCacheRefetch(videoID, time);
    } else {
        delete activeThumbnailCacheRequests[videoID];
    }

    return null;
}

function handleThumbnailCacheRefetch(videoID: VideoID, time?: number): Promise<Record<VideoID, BrandingResult> | null> {
    const data = activeThumbnailCacheRequests[videoID];
    delete activeThumbnailCacheRequests[videoID];

    if (data.time !== time) {
        return fetchBrandingFromThumbnailCache(videoID, data.time, cache[videoID]?.titles?.[0]?.title, data.shouldRerequest, true);
    }

    return Promise.resolve(null);
}

export function queueThumbnailCacheRequest(videoID: VideoID, time?: number, title?: string, generateNow?: boolean): void {
    if (activeThumbnailCacheRequests[videoID]) {
        activeThumbnailCacheRequests[videoID].time = time;
        activeThumbnailCacheRequests[videoID].generateNow ||= generateNow ?? false;
        return;
    }

    fetchBrandingFromThumbnailCache(videoID, time, title, generateNow).catch(logError);
}

export function clearCache(videoID: VideoID) {
    delete cache[videoID];
}

export async function submitVideoBranding(videoID: VideoID, title: TitleSubmission | null, thumbnail: ThumbnailSubmission | null): Promise<FetchResponse> {
    const result = await sendRequestToServer("POST", "/api/branding", {
        userID: Config.config!.userID,
        videoID,
        title,
        thumbnail
    });

    clearCache(videoID);
    return result;
}

export function sendRequestToServer(type: string, url: string, data = {}): Promise<FetchResponse> {
    return sendRequestToCustomServer(type, Config.config!.serverAddress + url, data);
}

export function sendRequestToThumbnailCache(videoID: string, time?: number, title?: string, generateNow = false): Promise<Response> {
    const data = {
        videoID,
        generateNow
    };

    if (time) {
        data["time"] = time;
    }

    if (title) {
        data["title"] = title;
    }
    
    return sendRealRequestToCustomServer("GET", `${Config.config?.thumbnailServerAddress}/api/v1/getThumbnail`, data);
}