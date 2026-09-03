import { FunctionalComponent, JSX } from "preact"
import { useEffect, useState, useRef } from "preact/hooks"
import { ButtonImg, Loading, CenterLeft, Progress } from "../../components/Controls"
import {
    addHttpFailureToast,
    getHttpFailureMessage,
    useHttpQueue,
    useTargetCommands,
} from "../../hooks"
import { useWebSocketService } from "../../hooks/useWebSocketService"
import { espHttpURL } from "../../components/Helpers"
import { T } from "../../components/Translations"
import {
    useUiContext,
    useModalsContext,
    useToastsContext,
    useUiContextFn,
    useSettingsContext,
    useSettingsContextFn,
} from "../../contexts"
import { Esp3dVersion, webUIversion } from "../../components/App/version"
import { Github, RefreshCcw, UploadCloud, LifeBuoy, Info, BookOpen, Download } from "preact-feather"
import { webUiUrl, fwUrl, Name, restartdelay } from "../../targets"
import {
    showConfirmationModal,
    showModal,
    showProgressModal,
    showReleaseNotesModal,
    showFirmwareUpdateModal,
} from "../../components/Modal"
import { safeGitHubDownloadUrl } from "../../Services/GitHubDownloadUrl"
import { GitHubService } from "../../Services/GitHubService"
import type { GitHubRelease } from "../../types/github.types"
import type { HttpFailure } from "../../types/http.types"
import type { ModalInstanceId } from "../../contexts/ModalsContext"
import { VersionBadge } from "../../components/VersionBadge"
import { parseFileUploadResponse } from "../../Services/uploadResponse"
import { parseFirmwareUploadResponse } from "./uploadResponse"
import { openSafeExternalUrl } from "./externalLink"

interface AboutData {
    id: string
    value: string
}

interface ProgressBar {
    update?: (value: number) => void
}

type UploadKind = "firmware" | "webui"

let about: AboutData[] = []
let liveStatsCapability: boolean | undefined

const defaultHelpUrl = "http://wiki.fluidnc.com/"

const isUnknownCommandText = (value: unknown, allowEmpty = false): boolean => {
    const text = value == null ? "" : String(value).trim().toLowerCase()
    if (!text) return allowEmpty
    return (
        text.includes("unknown command") ||
        text.includes("invalid $ statement") ||
        /^error\s*:\s*3(?:\s|$)/.test(text)
    )
}

const isUnsupportedLiveStatsFailure = (error: unknown): boolean => {
    const failure = error as { code?: number } | null | undefined
    const text = getHttpFailureMessage(error).trim()
    return failure?.code === 404 || /^404(?:\s|$|-)/.test(text) || isUnknownCommandText(text)
}

const CustomEntry: FunctionalComponent = (): JSX.Element => {
    const { interfaceSettings } = useSettingsContext()
    let HelpEntry: JSX.Element | null = null
    let InfoEntry: JSX.Element | null = null
    if (
        interfaceSettings.current.custom &&
        (interfaceSettings.current.custom.help || interfaceSettings.current.custom.information)
    ) {
        if (interfaceSettings.current?.custom?.help) {
            const helpUrl = interfaceSettings.current.custom.help
            const onClickHelp = (e: MouseEvent) => {
                useUiContextFn.haptic()
                openSafeExternalUrl(helpUrl, window)
                ;(e.target as HTMLElement).blur()
            }
            HelpEntry = <ButtonImg mx2 icon={<LifeBuoy />} label={T("S72")} onClick={onClickHelp} />
        }
        if (interfaceSettings.current?.custom?.information) {
            const infoUrl = interfaceSettings.current.custom.information
            const onClickInfo = (e: MouseEvent) => {
                useUiContextFn.haptic()
                openSafeExternalUrl(infoUrl, window)
                ;(e.target as HTMLElement).blur()
            }
            InfoEntry = <ButtonImg mx2 icon={<Info />} label={T("S123")} onClick={onClickInfo} />
        }
        return (
            <li class="feather-icon-container">
                {HelpEntry} {InfoEntry}
            </li>
        )
    }

    const onClickHelp = (e: MouseEvent) => {
        useUiContextFn.haptic()
        ;(window as any).open(defaultHelpUrl, "_blank")
        ;(e.target as HTMLElement).blur()
    }
    HelpEntry = (
        <ButtonImg
            mx2
            tooltip
            data-tooltip={T("S225")}
            icon={<BookOpen />}
            label="FluidNC Wiki"
            onClick={onClickHelp}
        />
    )
    return (
        <li class="feather-icon-container">
            <span class="text-primary text-label">{T("S225")}:</span>
            {HelpEntry}
        </li>
    )
}

const About: FunctionalComponent = (): JSX.Element => {
    console.log("about")
    const { uisettings } = useUiContext()
    const { toasts } = useToastsContext()
    const { modals } = useModalsContext()
    const webSocketService = useWebSocketService()
    const { createNewRequest, abortRequest } = useHttpQueue()
    const { targetCommands } = useTargetCommands()
    const { interfaceSettings, connectionSettings } = useSettingsContext()
    const [isLoading, setIsLoading] = useState<boolean>(true)
    const [isPropsRequestActive, setIsPropsRequestActive] = useState(false)
    const progressBar: ProgressBar = {}
    const [props, setProps] = useState<AboutData[]>([...about])
    const [latestRelease, setLatestRelease] = useState<GitHubRelease | null>(null)
    const [availableReleases, setAvailableReleases] = useState<GitHubRelease[]>([])
    const [latestFirmwareRelease, setLatestFirmwareRelease] = useState<GitHubRelease | null>(null)
    const [availableFirmwareReleases, setAvailableFirmwareReleases] = useState<GitHubRelease[]>([])
    const propsRequestInFlight = useRef(false)
    const hasProps = useRef(props.length > 0)
    const mounted = useRef(false)
    const liveStatsSupported = useRef<boolean | undefined>(liveStatsCapability)
    const liveRefreshEnabled = useRef(false)
    const liveRefreshTimer = useRef<number | undefined>(undefined)
    const uploadFlowActive = useRef(false)
    const pendingUploadKind = useRef<UploadKind | null>(null)
    const activeUploadKind = useRef<UploadKind | null>(null)
    const filePickerOpen = useRef(false)
    const inputFilesRef = useRef<HTMLInputElement>(null)
    const isFlashFS = connectionSettings.current.FlashFileSystem == "none" ? false : true
    const isSDFS = connectionSettings.current.SDConnection == "none" ? false : true

    const scheduleNextRefresh = (): void => {
        if (!liveRefreshEnabled.current || uploadFlowActive.current) return
        if (liveRefreshTimer.current != undefined) window.clearTimeout(liveRefreshTimer.current)
        liveRefreshTimer.current = window.setTimeout(() => {
            liveRefreshTimer.current = undefined
            getProps()
        }, 10_000)
    }

    const finishPropsRequest = (): void => {
        propsRequestInFlight.current = false
        if (!mounted.current) return
        setIsPropsRequestActive(false)
        setIsLoading(false)
        scheduleNextRefresh()
    }

    const pauseAboutPolling = (): void => {
        uploadFlowActive.current = true
        if (liveRefreshTimer.current != undefined) {
            window.clearTimeout(liveRefreshTimer.current)
            liveRefreshTimer.current = undefined
        }
        abortRequest("about-esp421")
        abortRequest("about-esp420-legacy")
        propsRequestInFlight.current = false
        if (mounted.current) setIsPropsRequestActive(false)
    }

    const resumeAboutPolling = (): void => {
        uploadFlowActive.current = false
        if (liveRefreshEnabled.current) scheduleNextRefresh()
    }

    const finishUploadFlow = (): void => {
        pendingUploadKind.current = null
        activeUploadKind.current = null
        filePickerOpen.current = false
        if (inputFilesRef.current) inputFilesRef.current.value = ""
        resumeAboutPolling()
    }

    const openUploadFilePicker = (kind: UploadKind): void => {
        pauseAboutPolling()
        pendingUploadKind.current = kind
        activeUploadKind.current = null
        filePickerOpen.current = true

        const input = inputFilesRef.current
        if (!input) {
            finishUploadFlow()
            return
        }

        input.value = ""
        input.accept = kind === "firmware" ? ".bin" : "*"
        input.multiple = kind === "webui"
        try {
            input.click()
        } catch (error) {
            console.log(error)
            finishUploadFlow()
        }
    }

    const cancelPendingUpload = (): void => {
        if (!pendingUploadKind.current && !uploadFlowActive.current) return
        finishUploadFlow()
    }

    const detectClosedFilePicker = (): void => {
        window.setTimeout(() => {
            if (!filePickerOpen.current) return
            filePickerOpen.current = false
            const list = inputFilesRef.current?.files
            if (!list || list.length === 0) cancelPendingUpload()
        }, 0)
    }

    const applyPropsResponse = (result: any, expectedCommand: number): "ok" | "unsupported" | "invalid" => {
        if (isUnknownCommandText(result, true)) return "unsupported"
        try {
            const jsonResult = JSON.parse(result)
            if (jsonResult.cmd != expectedCommand || jsonResult.status == "error" || !Array.isArray(jsonResult.data)) {
                return isUnknownCommandText(jsonResult.data) ? "unsupported" : "invalid"
            }
            if (mounted.current) {
                setProps([...jsonResult.data])
                about = [...jsonResult.data]
                hasProps.current = true
            }
            return "ok"
        } catch (error) {
            console.log(error)
            return "invalid"
        }
    }

    const requestLegacyProps = (manual: boolean): void => {
        liveStatsSupported.current = false
        liveStatsCapability = false
        liveRefreshEnabled.current = false
        if (liveRefreshTimer.current != undefined) {
            window.clearTimeout(liveRefreshTimer.current)
            liveRefreshTimer.current = undefined
        }

        const callbacks = {
            onSuccess: (result: any) => {
                if (applyPropsResponse(result, 420) != "ok" && mounted.current && manual) {
                    toasts.addToast({ content: T("S194"), type: "error" })
                }
                finishPropsRequest()
            },
            onFail: (error: HttpFailure) => {
                if (mounted.current && manual) addHttpFailureToast(toasts, error)
                console.log(error)
                finishPropsRequest()
            },
        }

        try {
            const accepted = targetCommands(
                "[ESP420]json=yes",
                undefined,
                { id: "about-esp420-legacy", max: 1, echo: false, timeoutMs: 8_000 },
                callbacks
            )
            if (!accepted) {
                if (mounted.current && manual) toasts.addToast({ content: T("S194"), type: "error" })
                finishPropsRequest()
            }
        } catch (error) {
            if (mounted.current && manual) toasts.addToast({ content: T("S194"), type: "error" })
            console.log(error)
            finishPropsRequest()
        }
    }

    const requestLiveProps = (manual: boolean): void => {
        const callbacks = {
            onSuccess: (result: any) => {
                const response = applyPropsResponse(result, 421)
                if (response == "ok") {
                    liveStatsSupported.current = true
                    liveStatsCapability = true
                    finishPropsRequest()
                } else if (mounted.current && response == "unsupported" && liveStatsSupported.current == undefined) {
                    requestLegacyProps(manual)
                } else {
                    if (mounted.current && manual) toasts.addToast({ content: T("S194"), type: "error" })
                    finishPropsRequest()
                }
            },
            onFail: (error: HttpFailure) => {
                if (mounted.current && liveStatsSupported.current == undefined && isUnsupportedLiveStatsFailure(error)) {
                    requestLegacyProps(manual)
                    return
                }
                // Automatic live polling is best effort. Keep the last good values
                // on transient HTTP failures (including 503) and retry after this
                // request settles without spamming one toast per poll.
                if (mounted.current && manual) addHttpFailureToast(toasts, error)
                console.log(error)
                finishPropsRequest()
            },
        }

        try {
            const accepted = targetCommands(
                "[ESP421]json=yes",
                undefined,
                { id: "about-esp421", max: 1, echo: false, timeoutMs: 8_000 },
                callbacks
            )
            if (!accepted) {
                if (mounted.current && manual) toasts.addToast({ content: T("S194"), type: "error" })
                finishPropsRequest()
            }
        } catch (error) {
            if (mounted.current && manual) toasts.addToast({ content: T("S194"), type: "error" })
            console.log(error)
            finishPropsRequest()
        }
    }

    const getProps = (manual = false): void => {
        if (uploadFlowActive.current) return
        if (manual && liveRefreshTimer.current != undefined) {
            window.clearTimeout(liveRefreshTimer.current)
            liveRefreshTimer.current = undefined
        }
        if (propsRequestInFlight.current) return
        propsRequestInFlight.current = true
        if (mounted.current) {
            setIsPropsRequestActive(true)
            if (manual || !hasProps.current) setIsLoading(true)
        }
        if (liveStatsSupported.current === false) requestLegacyProps(manual)
        else requestLiveProps(manual)
    }

    //from https://stackoverflow.com/questions/5916900/how-can-you-detect-the-version-of-a-browser
    function getBrowserInformation(): string {
        var ua = navigator.userAgent,
            tem: any,
            M: any = ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) || []
        if (/trident/i.test(M[1])) {
            tem = /\brv[ :]+(\d+)/g.exec(ua) || []
            return `IE ${tem[1] || ""}`
        }
        if (M[1] === "Chrome") {
            tem = ua.match(/\b(OPR|Edge)\/(\d+)/)
            if (tem != null) return tem.slice(1).join(" ").replace("OPR", "Opera")
        }
        M = M[2] ? [M[1], M[2]] : [navigator.appName, navigator.appVersion, "-?"]
        if ((tem = ua.match(/version\/(\d+)/i)) != null) M.splice(1, 1, tem[1])
        return M.join(" ")
    }

    const onFWUpdate = (e: MouseEvent) => {
        useUiContextFn.haptic()
        ;(e.target as HTMLElement).blur()

        const uploadFromDisk = () => {
            modals.removeModalById("firmware-update-choice")
            openUploadFilePicker("firmware")
        }

        const downloadFromGithub = () => {
            modals.removeModalById("firmware-update-choice")
            const currentFirmwareVersion = props.find((element) => element.id == "FW version")?.value || "Unknown"

            showFirmwareUpdateModal({
                modals,
                releases: availableFirmwareReleases,
                currentVersion: currentFirmwareVersion,
                onUploadFile: () => {
                    modals.removeModalById("firmware-update")
                    openUploadFilePicker("firmware")
                },
                onViewReleaseNotes: () => {
                    modals.removeModalById("firmware-update")
                    const releasesToShow =
                        availableFirmwareReleases.length > 0 ? availableFirmwareReleases.slice(0, 10) : []

                    if (releasesToShow.length === 0) {
                        toasts.addToast({
                            content: "No firmware release information available",
                            type: "error",
                        })
                        return
                    }

                    showReleaseNotesModal({
                        modals,
                        releases: releasesToShow,
                        githubUrl: "https://github.com/bdring/FluidNC/releases",
                    })
                },
            })
        }

        showModal({
            modals,
            title: "Update Firmware",
            content: (
                <CenterLeft>
                    <div class="mb-4">
                        <p class="mb-3 text-center">Choose an update method:</p>

                        <div class="mb-3">
                            <button
                                class="btn btn-primary btn-lg btn-block"
                                onClick={downloadFromGithub}
                                disabled={availableFirmwareReleases.length === 0}>
                                <Download size={18} class="mr-2" style="vertical-align: middle;" />
                                Download from GitHub
                            </button>
                            <small class="text-muted d-block mt-1 text-center">
                                Download firmware release, extract, then upload .bin file
                            </small>
                        </div>

                        <div class="divider text-center" data-content="OR" />

                        <div class="mb-3">
                            <button class="btn btn-primary btn-lg btn-block" onClick={uploadFromDisk}>
                                <UploadCloud size={18} class="mr-2" style="vertical-align: middle;" />
                                Upload File from Computer
                            </button>
                            <small class="text-muted d-block mt-1 text-center">
                                Select a .bin file you already have
                            </small>
                        </div>

                        <div class="text-center mt-3">
                            <a
                                href="#"
                                class="text-primary"
                                onClick={(e) => {
                                    e.preventDefault()
                                    useUiContextFn.haptic()
                                    modals.removeModalById("firmware-update-choice")
                                    const releasesToShow =
                                        availableFirmwareReleases.length > 0
                                            ? availableFirmwareReleases.slice(0, 10)
                                            : []

                                    if (releasesToShow.length === 0) {
                                        toasts.addToast({
                                            content: "No firmware release information available",
                                            type: "error",
                                        })
                                        return
                                    }

                                    showReleaseNotesModal({
                                        modals,
                                        releases: releasesToShow,
                                        githubUrl: "https://github.com/bdring/FluidNC/releases",
                                    })
                                }}>
                                <BookOpen size={14} style="vertical-align: middle;" /> View Release Notes
                            </a>
                        </div>
                    </div>
                </CenterLeft>
            ),
            id: "firmware-update-choice",
            hideclose: false,
        })
    }
    const onFWGit = (e: MouseEvent) => {
        useUiContextFn.haptic()
        const i = useSettingsContextFn.getValue("Screen")
        let url = ""
        if (interfaceSettings.current.custom && interfaceSettings.current.custom.fwurl) {
            url = interfaceSettings.current.custom.fwurl
        } else if (i && i != "none" && (fwUrl as readonly any[]).length > 1) {
            url = (fwUrl as readonly any[])[1]
        } else {
            url = fwUrl[0] || ""
        }

        openSafeExternalUrl(url, window)
        ;(e.target as HTMLElement).blur()
    }

    const checkForUpdates = async () => {
        try {
            const githubService = new GitHubService({
                owner: "michmela44",
                repo: "ESP3D-WEBUI",
                assetName: "index.html.gz",
            })
            const latest = await githubService.getLatestRelease()
            setLatestRelease(latest)

            const releases = await githubService.getReleases(10)
            setAvailableReleases(releases)
        } catch (error) {
            console.error("Failed to check for updates:", error)
        }
    }

    const checkForFirmwareUpdates = async () => {
        try {
            const githubService = new GitHubService({
                owner: "bdring",
                repo: "FluidNC",
                assetName: "", 
            })
            const latest = await githubService.getLatestRelease()
            setLatestFirmwareRelease(latest)

            const releases = await githubService.getReleases(10)
            setAvailableFirmwareReleases(releases)
        } catch (error) {
            console.error("Failed to check for firmware updates:", error)
        }
    }

    const showDownloadModal = () => {
        if (availableReleases.length === 0) {
            toasts.addToast({
                content: "No releases available. Check your internet connection.",
                type: "error",
            })
            return
        }

        let selectedReleaseIndex = 0

        const downloadSelectedRelease = () => {
            const selectedRelease = availableReleases[selectedReleaseIndex]
            const githubService = new GitHubService({
                owner: "michmela44",
                repo: "ESP3D-WEBUI",
                assetName: "index.html.gz",
            })

            const asset = githubService.findAssetByName(selectedRelease, "index.html.gz")
            if (!asset) {
                toasts.addToast({
                    content: `Asset 'index.html.gz' not found in release ${selectedRelease.tag_name}`,
                    type: "error",
                })
                return
            }

            const downloadUrl = safeGitHubDownloadUrl(asset.browser_download_url)
            if (!downloadUrl) {
                toasts.addToast({ content: "Release asset has an untrusted download URL", type: "error" })
                return
            }
            const link = document.createElement("a")
            link.href = downloadUrl
            link.download = "index.html.gz"
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)

            modals.removeModalById("github-download")

            toasts.addToast({
                content: `Downloading ${selectedRelease.tag_name}. Use 'Upload to Device' button after download completes.`,
                type: "success",
            })
        }

        const cancelDownload = () => {
            modals.removeModalById("github-download")
        }

        const compareVersions = (current: string, target: string): string => {
            const cleanCurrent = current.split(".").slice(0, 3).join(".")
            const cleanTarget = target.replace(/^v/, "").split(".").slice(0, 3).join(".")

            const currentParts = cleanCurrent.split(".").map(Number)
            const targetParts = cleanTarget.split(".").map(Number)

            for (let i = 0; i < 3; i++) {
                if ((currentParts[i] || 0) < (targetParts[i] || 0)) return "upgrade"
                if ((currentParts[i] || 0) > (targetParts[i] || 0)) return "downgrade"
            }
            return "same"
        }

        showModal({
            modals,
            title: "Download Web UI from GitHub",
            content: (
                <CenterLeft>
                    <div class="mb-3 p-3" style="background-color: #f8f9fa; border-radius: 4px;">
                        <div class="d-flex justify-content-between align-items-center">
                            <div style="flex: 1;">
                                <small class="text-muted d-block">Current Version</small>
                                <strong>{webUIversion}</strong>
                            </div>
                            {latestRelease && (
                                <>
                                    <div style="flex: 1; text-align: center; padding: 0 1rem;">
                                        {compareVersions(webUIversion, latestRelease.tag_name) === "upgrade" && (
                                            <span class="text-success">Upgrade Available</span>
                                        )}
                                        {compareVersions(webUIversion, latestRelease.tag_name) === "same" && (
                                            <span class="text-muted">Up to date</span>
                                        )}
                                    </div>
                                    <div style="flex: 1; text-align: right;">
                                        <small class="text-muted d-block">Latest Release</small>
                                        <strong class="text-success">{latestRelease.tag_name}</strong>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    <div class="mt-3">
                        <label class="form-label">
                            <strong>Select version to download:</strong>
                        </label>
                        <select
                            id="release-selector"
                            class="form-control"
                            onChange={(e) => {
                                selectedReleaseIndex = parseInt((e.target as HTMLSelectElement).value)
                                const infoBox = document.getElementById("selected-release-info")
                                if (infoBox) {
                                    const selectedRelease = availableReleases[selectedReleaseIndex]
                                    infoBox.textContent = `${selectedRelease.tag_name} - Released ${new Date(
                                        selectedRelease.published_at
                                    ).toLocaleDateString()}`
                                }
                            }}>
                            {availableReleases.map((release, index) => (
                                <option key={release.id} value={index}>
                                    {release.name}
                                    {index === 0 ? " (Latest)" : ""}
                                </option>
                            ))}
                        </select>
                        <small id="selected-release-info" class="text-muted d-block mt-1">
                            {availableReleases[0]?.tag_name} - Released{" "}
                            {new Date(availableReleases[0]?.published_at || "").toLocaleDateString()}
                        </small>
                    </div>
                </CenterLeft>
            ),
            button1: {
                text: "Download",
                cb: downloadSelectedRelease,
                noclose: true,
            },
            button2: {
                text: "Cancel",
                cb: cancelDownload,
                noclose: true,
            },
            id: "github-download",
            hideclose: false,
        })
    }

    const showReleaseNotes = () => {
        const releasesToShow = availableReleases.length > 0 ? availableReleases.slice(0, 10) : []

        if (releasesToShow.length === 0) {
            toasts.addToast({
                content: "No release information available",
                type: "error",
            })
            return
        }

        showReleaseNotesModal({
            modals,
            releases: releasesToShow,
            githubUrl: "https://github.com/michmela44/ESP3D-WEBUI/releases",
        })
    }
    const onWebUiUpdate = (e: MouseEvent) => {
        useUiContextFn.haptic()
        ;(e.target as HTMLElement).blur()

        showModal({
            modals,
            title: "Update Web UI",
            content: (
                <CenterLeft>
                    <div class="mb-4">
                        <p class="mb-3 text-center">Choose an update method:</p>

                        <div class="mb-3">
                            <button
                                class="btn btn-primary btn-lg btn-block"
                                onClick={() => {
                                    modals.removeModalById("webui-upload")
                                    showDownloadModal()
                                }}
                                disabled={availableReleases.length === 0}>
                                <Download size={18} class="mr-2" style="vertical-align: middle;" />
                                Download from GitHub
                            </button>
                            <small class="text-muted d-block mt-1 text-center">
                                Download a release, then upload it to your device
                            </small>
                        </div>

                        <div class="divider text-center" data-content="OR" />

                        <div class="mb-3">
                            <button
                                class="btn btn-primary btn-lg btn-block"
                                onClick={() => {
                                    modals.removeModalById("webui-upload")
                                    openUploadFilePicker("webui")
                                }}>
                                <UploadCloud size={18} class="mr-2" style="vertical-align: middle;" />
                                Upload File from Computer
                            </button>
                            <small class="text-muted d-block mt-1 text-center">
                                Select an index.html.gz file you already have
                            </small>
                        </div>

                        <div class="text-center mt-3">
                            <a
                                href="#"
                                class="text-primary"
                                onClick={(e) => {
                                    e.preventDefault()
                                    useUiContextFn.haptic()
                                    modals.removeModalById("webui-upload")
                                    showReleaseNotes()
                                }}>
                                <BookOpen size={14} style="vertical-align: middle;" /> View Release Notes
                            </a>
                        </div>
                    </div>
                </CenterLeft>
            ),
            id: "webui-upload",
            hideclose: false,
        })
    }
    const onWebUiGit = (e: MouseEvent) => {
        useUiContextFn.haptic()
        ;(window as any)
            .open(
                webUiUrl,
                "_blank"
            )(e.target as HTMLElement)
            .blur()
    }

    const uploadFiles = (renameToIndexHtml = false): void => {
        const uploadKind = pendingUploadKind.current
        const list = inputFilesRef.current?.files
        if (!uploadKind || !list || list.length === 0) {
            finishUploadFlow()
            return
        }
        const files = Array.from(list)

        pauseAboutPolling()
        pendingUploadKind.current = null
        activeUploadKind.current = uploadKind

        const hostUploadPath = useSettingsContextFn.getValue("HostUploadPath")
        const formData = new FormData()
        formData.append("path", hostUploadPath)
        formData.append("createPath", "true")
        for (const file of files) {
            const fileName = renameToIndexHtml && file.name.toLowerCase().endsWith(".html.gz") ? "index.html.gz" : file.name
            const uploadPath = hostUploadPath + fileName
            formData.append(`${uploadPath}S`, String(file.size))
            formData.append("myfiles", file, uploadPath)
        }
        if (inputFilesRef.current) inputFilesRef.current.value = ""

        let progressModalId: ModalInstanceId | undefined
        const removeProgressModal = (): void => {
            if (progressModalId) modals.removeModalByInstanceId(progressModalId)
        }
        const cancelUpload = (): void => {
            abortRequest("upload")
            removeProgressModal()
            finishUploadFlow()
        }

        progressModalId = showProgressModal({
            modals,
            title: T("S32"),
            button1: { cb: cancelUpload, text: T("S28") },
            content: <Progress progressBar={progressBar} max={100} />,
        })

        const base = uploadKind === "firmware" ? "updatefw" : useSettingsContextFn.getValue("HostTarget")
        let accepted = false
        try {
            accepted = createNewRequest(
                espHttpURL(base),
                { method: "POST", id: "upload", body: formData },
                {
                    onSuccess: (result: any) => {
                        const completedUploadKind = activeUploadKind.current
                        if (!completedUploadKind) return

                        const uploadResult =
                            completedUploadKind === "firmware"
                                ? parseFirmwareUploadResponse(result)
                                : parseFileUploadResponse(result)
                        if (!uploadResult.ok) {
                            removeProgressModal()
                            toasts.addToast({ content: uploadResult.message, type: "error" })
                            finishUploadFlow()
                            return
                        }

                        if (progressBar.update && typeof progressBar.update === "function") progressBar.update(100)
                        removeProgressModal()
                        activeUploadKind.current = null
                        uploadFlowActive.current = false
                        webSocketService?.disconnect(completedUploadKind === "firmware" ? "restart" : "connecting")

                        if (completedUploadKind === "firmware") {
                            setTimeout(() => window.location.reload(), restartdelay * 1000)
                        } else {
                            window.location.reload()
                        }
                    },
                    onFail: (error: HttpFailure) => {
                        removeProgressModal()
                        addHttpFailureToast(toasts, error)
                        pendingUploadKind.current = null
                        activeUploadKind.current = null
                        finishUploadFlow()
                    },
                    onProgress: (e: number) => {
                        if (progressBar.update && typeof progressBar.update === "function") progressBar.update(e)
                    },
                }
            )
        } catch (error) {
            console.log(error)
        }

        if (!accepted) {
            removeProgressModal()
            toasts.addToast({ content: "Upload could not be started", type: "error" })
            finishUploadFlow()
        }
    }

    const valueTranslated = (value: string): string => {
        if (value.startsWith("ON (") || value.startsWith("OFF (") || value.startsWith("shared (")) {
            const reg_search = /(?<label>[^(]*)\s\((?<content>[^)]*)/
            let res = reg_search.exec(value)
            if (res && res.groups) {
                return `${T(res.groups.label)} (${T(res.groups.content)})`
            }
        }

        return T(value)
    }

    const filePickerCancelled = (_e: Event): void => {
        filePickerOpen.current = false
        cancelPendingUpload()
    }

    const filesSelected = (_e: Event) => {
        filePickerOpen.current = false
        const uploadKind = pendingUploadKind.current
        const list = inputFilesRef.current?.files
        if (!uploadKind || !list || list.length === 0) {
            cancelPendingUpload()
            return
        }

        const titleConfirmation = uploadKind === "firmware" ? T("S30") : T("S31")
        const fileList = Array.from(list)

        const showStandardConfirmation = () => {
            const content = (
                <CenterLeft>
                    <ul>
                        {fileList.reduce((accumulator: JSX.Element[], currentElement: File) => {
                            return [...accumulator, <li key={currentElement.name}>{currentElement.name}</li>]
                        }, [])}
                    </ul>
                </CenterLeft>
            )
            showConfirmationModal({
                modals,
                title: titleConfirmation,
                content,
                button1: {
                    cb: () => {
                        uploadFiles()
                    },
                    text: T("S27"),
                },
                button2: {
                    cb: cancelPendingUpload,
                    text: T("S28"),
                },
            })
        }

        const incorrectFiles = uploadKind === "webui"
            ? fileList.filter((file) => file.name.toLowerCase().endsWith(".html.gz") && file.name !== "index.html.gz")
            : []
        const canRenameWebUIFile =
            incorrectFiles.length === 1 &&
            fileList.length === 1 &&
            !fileList.some((file) => file.name === "index.html.gz")

        if (incorrectFiles.length > 0) {

            const renameAndUpload = () => {
                useUiContextFn.haptic()
                modals.removeModalById("filename-warning")
                showConfirmationModal({
                    modals,
                    title: titleConfirmation,
                    content: (
                        <CenterLeft>
                            <p class="text-success mb-2">
                                File will be renamed to <code>index.html.gz</code> during upload.
                            </p>
                            <ul>
                                <li>index.html.gz</li>
                            </ul>
                        </CenterLeft>
                    ),
                    button1: {
                        cb: () => {
                            uploadFiles(true)
                        },
                        text: T("S27"),
                    },
                    button2: {
                        cb: cancelPendingUpload,
                        text: T("S28"),
                    },
                })
            }

            const continueAnyway = () => {
                useUiContextFn.haptic()
                modals.removeModalById("filename-warning")
                showStandardConfirmation()
            }

            const cancelUpload = () => {
                useUiContextFn.haptic()
                modals.removeModalById("filename-warning")
                cancelPendingUpload()
            }

            modals.addModal({
                id: "filename-warning",
                title: (
                    <div class="text-primary feather-icon-container modal_title">
                        <label>Warning: Incorrect Filename</label>
                    </div>
                ),
                content: (
                    <CenterLeft>
                        <p class="text-warning mb-2">
                            <strong>The following file(s) have incorrect names:</strong>
                        </p>
                        <ul class="mb-2">
                            {incorrectFiles.map((file) => (
                                <li key={file.name}>{file.name}</li>
                            ))}
                        </ul>
                        <p class="mb-2">
                            The built-in WebUI will only work with the exact filename <code>index.html.gz</code>.
                        </p>
                        <p class="mb-0">What would you like to do?</p>
                    </CenterLeft>
                ),
                footer: (
                    <div>
                        {canRenameWebUIFile && (
                            <button class="btn btn-primary mx-2" onClick={renameAndUpload}>
                                Rename and Upload
                            </button>
                        )}
                        <button class="btn mx-2" onClick={continueAnyway}>
                            Upload Anyway
                        </button>
                        <button class="btn mx-2" onClick={cancelUpload}>
                            Cancel
                        </button>
                    </div>
                ),
                overlay: true,
                hideclose: true,
            })
            return
        }

        showStandardConfirmation()
    }

    useEffect(() => {
        mounted.current = true
        if (uisettings.getValue("autoload")) {
            liveRefreshEnabled.current = liveStatsSupported.current !== false
            if (liveStatsSupported.current === false && hasProps.current) setIsLoading(false)
            else getProps()
        } else {
            setIsLoading(false)
        }

        window.addEventListener("focus", detectClosedFilePicker)

        return () => {
            window.removeEventListener("focus", detectClosedFilePicker)
            mounted.current = false
            liveRefreshEnabled.current = false
            propsRequestInFlight.current = false
            if (liveRefreshTimer.current != undefined) {
                window.clearTimeout(liveRefreshTimer.current)
                liveRefreshTimer.current = undefined
            }
        }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        checkForUpdates()
        checkForFirmwareUpdates()
    }, [])

    return (
        <div id="about" class="container">
            <input
                ref={inputFilesRef}
                type="file"
                class="d-none"
                onChange={filesSelected}
                onCancel={filePickerCancelled}
            />
            <h4>
                {T("S12").replace(
                    "%s",
                    interfaceSettings.current &&
                        interfaceSettings.current.custom &&
                        interfaceSettings.current.custom.name
                        ? interfaceSettings.current.custom.name
                        : Name
                )}
            </h4>
            {isLoading && <Loading />}

            {!isLoading && props && (
                <div>
                    <hr />
                    <CenterLeft>
                        <ul>
                            <li>
                                <span class="text-primary text-label">{T("S150")}: </span>
                                <span class="text-dark">
                                    <Esp3dVersion />
                                </span>
                                {latestRelease && (
                                    <VersionBadge
                                        current={webUIversion}
                                        latest={latestRelease.tag_name.replace("v", "")}
                                    />
                                )}
                                <ButtonImg
                                    sm
                                    mx2
                                    tooltip
                                    data-tooltip={T("S20")}
                                    icon={<Github />}
                                    onClick={onWebUiGit}
                                />
                                {(isFlashFS || isSDFS) && (
                                    <ButtonImg
                                        sm
                                        mx2
                                        tooltip
                                        data-tooltip={T("S171")}
                                        icon={<UploadCloud />}
                                        label={T("S25")}
                                        onClick={onWebUiUpdate}
                                    />
                                )}
                            </li>
                            <li>
                                <span class="text-primary text-label">{T("FW ver")}:</span>
                                <span class="text-dark">
                                    {props.find((element) => element.id == "FW version") &&
                                        props.find((element) => element.id == "FW version")?.value}
                                </span>
                                {latestFirmwareRelease && props.find((element) => element.id == "FW version") && (
                                    <VersionBadge
                                        current={
                                            props
                                                .find((element) => element.id == "FW version")
                                                ?.value.replace(/^FluidNC\s+/i, "")
                                                .replace(/^v/, "")
                                                .split(/[-_]/)[0] || ""
                                        }
                                        latest={latestFirmwareRelease.tag_name.replace(/^v/, "").split(/[-_]/)[0]}
                                    />
                                )}
                                <ButtonImg sm mx2 tooltip data-tooltip={T("S20")} icon={<Github />} onClick={onFWGit} />
                                {connectionSettings.current.WebUpdate == "Enabled" && (
                                    <ButtonImg
                                        sm
                                        mx2
                                        tooltip
                                        data-tooltip={T("S172")}
                                        icon={<UploadCloud />}
                                        label={T("S25")}
                                        onClick={onFWUpdate}
                                    />
                                )}
                            </li>
                            <CustomEntry />
                            <li>
                                <span class="text-primary text-label">{T("S18")}:</span>
                                <span class="text-dark">{getBrowserInformation()}</span>
                            </li>
                            {props.map(({ id, value }: AboutData) => {
                                if (id != "FW version")
                                    return (
                                        <li key={id}>
                                            <span class="text-primary text-label">{T(id)}:</span>
                                            <span class="text-dark">{valueTranslated(value)}</span>
                                        </li>
                                    )
                            })}
                        </ul>
                    </CenterLeft>
                    <hr />
                    <div style="text-align: center;">
                        <ButtonImg
                            icon={<RefreshCcw />}
                            label={T("S50")}
                            tooltip
                            data-tooltip={T("S23")}
                            disabled={isPropsRequestActive}
                            onClick={() => {
                                useUiContextFn.haptic()
                                getProps(true)
                            }}
                        />
                    </div>
                </div>
            )}
            <br />
        </div>
    )
}

export default About
