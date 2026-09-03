/*
 HttpQueueContext.tsx - ESP3D WebUI context file

 Copyright (c) 2021 Alexandre Aussourd. All rights reserved.
 Modified by Luc LEBOSSE 2021

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
import { createContext, FunctionalComponent } from "preact"
import { useContext, useRef } from "preact/hooks"
import { httpAdapter } from "../adapters"
import { useUiContext } from "./UiContext"
import { getWebSocketService } from "../hooks/useWebSocketService"
import { useTargetContext } from "../targets"
import { HttpQueueController } from "./HttpQueueController"
import type { HttpRequest } from "./HttpQueueController"

interface HttpQueueContextValue {
    addInQueue: (request: HttpRequest) => boolean
    addInTopQueue: (request: HttpRequest) => void
    cancelRequests: (requestIds: string | string[]) => void
    removeAllRequests: () => void
    processRequests: () => void
}

interface HttpQueueContextProviderProps {
    children: any
}

const HttpQueueContext = createContext<HttpQueueContextValue | undefined>(undefined)
const useHttpQueueContext = (): HttpQueueContextValue => {
    const context = useContext(HttpQueueContext)
    // Allow usage before provider is mounted (for circular dependencies with WsContext)
    if (!context) {
        return {
            addInQueue: () => false,
            addInTopQueue: () => {},
            cancelRequests: () => {},
            removeAllRequests: () => {},
            processRequests: () => {},
        }
    }
    return context
}

const HttpQueueContextProvider: FunctionalComponent<HttpQueueContextProviderProps> = ({ children }) => {
    const { processData } = useTargetContext()
    const { connection } = useUiContext()
    const processDataRef = useRef(processData)
    const connectionRef = useRef(connection)
    processDataRef.current = processData
    connectionRef.current = connection

    const controllerRef = useRef<HttpQueueController>()
    if (!controllerRef.current) {
        controllerRef.current = new HttpQueueController({
            httpAdapter,
            processData: (type, data) => processDataRef.current(type, data),
            getConnectionState: () => connectionRef.current.connectionState,
            setConnectionState: (state) => connectionRef.current.setConnectionState(state),
            getWebSocketService,
        })
    }
    const controller = controllerRef.current

    return (
        <HttpQueueContext.Provider
            value={{
                addInQueue: (request) => controller.addInQueue(request),
                addInTopQueue: (request) => controller.addInTopQueue(request),
                cancelRequests: (requestIds) => controller.cancelRequests(requestIds),
                removeAllRequests: () => controller.removeAllRequests(),
                processRequests: () => controller.processRequests(),
            }}
        >
            {children}
        </HttpQueueContext.Provider>
    )
}

export { HttpQueueContextProvider, useHttpQueueContext }
export type { HttpQueueContextValue, HttpRequest }
