import { useEffect } from "preact/hooks";
import { getWebSocketService } from "../../hooks/useWebSocketService";
import { useSettingsContext } from "../../contexts/SettingsContext";
import { useTargetCommands } from "../../hooks";
import { useTargetContextFn } from "../../targets";
import type { TargetContextFn } from "../../targets/types";
import { registerMacroRunner } from "../../targets/CNC/FluidNC/eventMacros";
import { executeMacroAction } from "../../targets/CNC/FluidNC/macroExecution";
import type { MacroType } from "../../targets/CNC/FluidNC/macroExecution";

export function ConnectionManager() {
    const { connectionSettings } = useSettingsContext();
    const { targetCommands, failToast } = useTargetCommands();

    useEffect(() => {
        // Connect if WebCommunication is enabled
        if (connectionSettings.current?.WebCommunication) {
            const service = getWebSocketService();

            if (service) {
                service.connect().catch(error => {
                    console.error("Failed to connect:", error);
                });
            } else {
                console.warn("WebSocketService not yet initialized - cannot connect");
            }
        }
    }, [connectionSettings, connectionSettings.current.WebCommunication]);

    // Registers the event-macros engine's ability to run a saved Macro (any
    // type) with the controller, so a firing rule works even when the Macros
    // panel isn't mounted (dashboard panels only render while visible - see
    // src/pages/dashboard/index.tsx's panels.visibles.map). Deliberately
    // registered HERE and not from TargetContextProvider (as originally
    // planned, alongside the existing ingestStatus/ingestAlarmFastPath push):
    // in App/index.tsx, TargetContextProvider is mounted ABOVE (an ancestor
    // of) ToastsContextProvider/HttpQueueContextProvider/SettingsContextProvider,
    // so calling useTargetCommands() there throws ("useToastsContext must be
    // used within a ToastsContextProvider") - it needs a descendant of all of
    // those. ConnectionManager already is one, and is just as unconditionally
    // mounted, so it's the right place - same push pattern, different (but
    // equally always-on) call site.
    useEffect(() => {
        const sendCommand = (command: string): void => {
            const { processData } = useTargetContextFn as TargetContextFn
            const callbacks = {
                onSuccess: (result: string) => {
                    processData("response", result)
                },
                onFail: failToast,
            }
            targetCommands(command, undefined, undefined, callbacks)
        }
        registerMacroRunner((action: string, type: MacroType) => {
            executeMacroAction(action, type, sendCommand)
        })
    }, [targetCommands, failToast]);

    // This component doesn't render anything
    return null;
}