async function parseResponse(response) {
    let payload = null;
    try {
        payload = await response.json();
    } catch (error) {
        payload = null;
    }

    if (!response.ok || !payload || payload.success !== true) {
        throw payload || { errorCode: 'internal' };
    }

    return payload;
}

/**
 * Sends only small metadata to Neos, then transfers browser-native binary
 * objects straight to the central relay. The opaque grant authenticates the
 * upload; CORS only restricts which configured browser origins may use it.
 */
export async function submitFeedbackDirect({
    prepareUrl,
    submission,
    screenshot,
    video = null,
    fetchImpl = window.fetch.bind(window),
}) {
    let prepareResponse;
    try {
        prepareResponse = await fetchImpl(prepareUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submission),
            credentials: 'same-origin',
        });
    } catch (error) {
        throw { errorCode: 'network' };
    }
    const grant = await parseResponse(prepareResponse);

    const formData = new FormData();
    // The encrypted grant can contain long feedback text. Send it as a small
    // file part: this avoids proxy header limits and lets PHP spool it to a
    // temporary file instead of holding a normal multipart field in memory.
    formData.append(
        'uploadGrant',
        new Blob([grant.uploadToken], { type: 'application/vnd.codeq.feedback-grant' }),
        'upload-grant.cqaf'
    );
    formData.append('screenshot', screenshot.blob, screenshot.fileName);
    if (video) {
        formData.append('video', video.blob, video.fileName);
    }

    let uploadResponse;
    try {
        uploadResponse = await fetchImpl(grant.uploadUrl, {
            method: 'POST',
            headers: {
                'X-Idempotency-Key': grant.idempotencyKey,
            },
            body: formData,
            credentials: 'omit',
            mode: 'cors',
        });
    } catch (error) {
        throw { errorCode: 'network' };
    }

    return parseResponse(uploadResponse);
}
