/*http.ts - ESP3D WebUI helpers file

 Copyright (c) 2021 Luc LEBOSSE. All rights reserved.

 This code is free software; you can redistribute it and/or
 modify it under the terms of the GNU Lesser General Public
 License as published by the Free Software Foundation; either
 version 2.1 of the License, or (at your option) any later version.
 This code is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 Lesser General Public License for more details.
 You should have received a copy of the GNU Lesser General Public
 License along with This code; if not, write to the Free Software
 Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
*/

function getCookie(cname: string): string {
    let name = `${cname  }=`
    let decodedCookie = decodeURIComponent(document.cookie)
    let ca = decodedCookie.split(";")
    for (var i = 0; i < ca.length; i++) {
        var c = ca[i]
        while (c.charAt(0) == " ") {
            c = c.substring(1)
        }
        if (c.indexOf(name) == 0) {
            return c.substring(name.length, c.length)
        }
    }
    return ""
}

//generate an URL with server host and base address
//args is array of arguments: [{'cmd':'[ESP800]},...]
const espHttpURL = (base: string = "", args: Record<string, string> = {}): string => {
    const url = (() => {
        try {
            return new URL(base)
        } catch (error) {
            return new URL(base, `http://${window.location.host}`)
        }
    })()
    Object.entries(args).forEach(([key, value]) =>
        url.searchParams.append(key, value)
    )
    return url.toString()
}

interface SilentFetchOptions {
    timeoutMs?: number
    onSettled?: () => void   // called once the request resolves/rejects/times out, for in-flight tracking
}

// Fire a GET request in the background without opening/navigating a tab.
// Used by manual URI_SILENT / [SILENT] macros and by the event-macros engine.
// Ignores the response body; logs success/failure only.
//
// mode: "no-cors" (rather than "cors") because the typical target here is a
// LAN device (e.g. a Tasmota smart plug) with no CORS headers - under "cors"
// the browser rejects reading such a response and the promise rejects into
// .catch(), logging a misleading "failed" even though the GET reached the
// device and ran (CORS only blocks reading the response, not sending the
// request). Under "no-cors" the response is opaque: response.ok/.status are
// always false/0 regardless of what actually happened at the target, so
// .then() can only honestly report that the request was sent, not that it
// succeeded at the HTTP level. .catch() still means something real under
// no-cors - it only fires for network-level failures (DNS, connection
// refused, timeout), not CORS.
function silentFetch(uri: string, options?: SilentFetchOptions): void {
    const controller = options?.timeoutMs ? new AbortController() : undefined
    const timeoutHandle = controller
        ? setTimeout(() => controller.abort(), options!.timeoutMs)
        : undefined
    const myInit: RequestInit = {
        method: "GET",
        mode: "no-cors",
        cache: "default",
        ...(controller ? { signal: controller.signal } : {}),
    }
    fetch(uri, myInit)
        .then(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle)
            console.log("Request sent")
        })
        .catch((error) => {
            if (timeoutHandle) clearTimeout(timeoutHandle)
            console.log(`Request failed: ${error.message}`)
        })
        .finally(() => {
            options?.onSettled?.()
        })
}

function isLimitedEnvironment(mode: string): boolean {
    let sitesList = [
        //google / android Captive Portal Detection
        "google.com",
        "connectivitycheck.",
        "googleapis.com",
        "gstatic.com",
        // Apple iPhone, iPad with iOS 6 Captive Portal Detection
        "apple.com",
        ".akamaitechnologies.com",
        // Apple iPhone, iPad with iOS 7, 8, 9 and recent versions of OS X
        "www.appleiphonecell.com",
        "www.itools.info",
        "www.ibook.info",
        "www.airport.us",
        "www.thinkdifferent.us",
        ".akamaiedge.net",
        // Windows
        ".msftncsi.com",
        "microsoft.com",
        ".msftconnecttest.com",
        // Firefox
        "detectportal.firefox.com",
        // Linux
        "network-test.debian.org",
        "nmcheck.gnome.org",
    ]
    if (mode != "AP") return false
    for (let i = 0; i < sitesList.length; i++) {
        if (document.location.host.indexOf(sitesList[i]) != -1) return true
    }
    return false
}

export { espHttpURL, getCookie, isLimitedEnvironment, silentFetch }
export type { SilentFetchOptions }
