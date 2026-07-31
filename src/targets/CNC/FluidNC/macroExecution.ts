// src/targets/CNC/FluidNC/macroExecution.ts
//
// Pure macro-execution logic, extracted from the Macros panel's own
// processMacro() (src/components/Panels/Macros.tsx) so a saved Macro can be
// run from somewhere other than that panel's own button click - specifically
// the event-macros engine (eventMacros.ts), which needs to fire a Macro even
// when the Macros panel isn't mounted (dashboard panels only render while
// visible - see src/pages/dashboard/index.tsx's panels.visibles.map, so a
// hidden panel simply doesn't exist in the DOM to click).
//
// No React/Preact here - everything this needs (files, silentFetch) is
// already hook-free. The one genuinely React-dependent piece, sending a
// command to the controller, is injected as a callback (sendCommand) rather
// than imported, so both callers - the Macros panel (its own sendCommand,
// backed by useTargetCommands()) and the event-macros engine (registered via
// registerMacroRunner() in eventMacros.ts) - share this ONE implementation
// instead of each having their own copy of the FS/SD/URI/URI_SILENT/CMD
// switch.

import { silentFetch } from "../../../components/Helpers"
import { files } from "./files"

export type MacroType = "FS" | "SD" | "URI" | "URI_SILENT" | "CMD"

function getSDSource(): string {
    for (const source of files.supported) {
        if (source.value == "DIRECTSD") {
            return source.value
        }
    }
    return "NONE"
}

export function executeMacroAction(
    action: string,
    type: MacroType,
    sendCommand: (command: string) => void
): void {
    switch (type) {
        case "FS":
            //[ESP700] //ESP700 should send status to telnet / websocket
            //Todo: handle response from ESP700
            sendCommand(`[ESP700]${action}`)
            break
        case "SD": {
            //get command accoring target FW
            const response = files.command(getSDSource(), "play", "", action)

            const cmds = response.cmd.split("\n")
            cmds.forEach((cmd: string) => {
                sendCommand(cmd)
            })

            break
        }
        //TODO:
        //TFT SD ? same as above
        //TFT USB ? same as above
        case "URI": {
            //open new page, or silent command via the legacy [SILENT] prefix
            if (action.trim().startsWith("[SILENT]")) {
                silentFetch(action.trim().replace("[SILENT]", "").trim())
            } else {
                window.open(action, "_blank", "noopener,noreferrer")
            }
            break
        }
        case "URI_SILENT":
            silentFetch(action.trim())
            break
        case "CMD": {
            //split by ; and show in terminal
            const commandsList = action.trim().split(";")
            commandsList.forEach((command) => {
                sendCommand(command)
            })
            break
        }
        default:
            console.log("type:", type, " action:", action)
            break
    }
}
