# Devon YouTube Data API setup

Devon can use the official YouTube Data API v3 for search and channel uploads while
keeping its existing embedded-player experience. The Data API adapter is a
metadata/search integration only: it does not expose media stream URLs or
provide video/audio downloads.

## Configure

Create an API key in Google Cloud, enable **YouTube Data API v3**, and add this
server-side environment variable:

```env
DEVON_YOUTUBE_DATA_API_KEY=your-server-side-api-key
```

Do not use a `NEXT_PUBLIC_` variable for this key. Restrict the key to the
YouTube Data API and the server environments that need it.

When the key is present, search and channel routes use the official Data API by
default. To explicitly select the existing youtubei.js metadata path for either
route, set:

```env
DEVON_YT_SEARCH_PROVIDER=innertube
DEVON_YT_CHANNEL_PROVIDER=innertube
```

Remove those overrides (or set them to another value) to return to the official
Data API provider. Without an API key, Devon continues to use its existing
search/channel implementation.

## Routes

- `GET /api/youtube/search?q=...` — official video search with duration and view
  count enrichment.
- `GET /api/youtube/search?next=...` — continuation page; the opaque token
  carries its original query.
- `GET /api/youtube/channel?c=...` — channel details and latest uploads.
- `GET /api/youtube/channel?next=...` — next uploads page.
- `GET /api/youtube/status` — reports whether the server has a Data API key
  and which search/channel provider is selected. It never returns the key.

The official API has quota limits. Search consumes quota, so monitor usage in
Google Cloud Console. A quota/key rejection is reported as a service
unavailable response rather than silently attempting another provider.

## Playback and downloads

The existing YouTube embed/player remains separate from metadata search. The
official Data API does not provide raw audio/video stream URLs. Devon must not
treat a metadata result as a downloadable media URL. Where an embedded player
is unavailable, show the provider's supported playback experience rather than
trying to defeat sign-in, bot-detection, or access-control checks.
