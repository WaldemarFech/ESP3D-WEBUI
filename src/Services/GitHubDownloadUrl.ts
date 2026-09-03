const trustedGitHubDownloadHosts = new Set([
    "github.com",
    "objects.githubusercontent.com",
])

export const safeGitHubDownloadUrl = (value: string): string | null => {
    try {
        const url = new URL(value)
        const trustedHost = trustedGitHubDownloadHosts.has(url.hostname)
        const hasAuthorityCredentials = url.username !== "" || url.password !== ""
        const hasCustomPort = url.port !== ""

        return url.protocol === "https:" && trustedHost && !hasAuthorityCredentials && !hasCustomPort
            ? url.toString()
            : null
    } catch {
        return null
    }
}
