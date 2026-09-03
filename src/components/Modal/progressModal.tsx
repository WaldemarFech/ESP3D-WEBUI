/*
 progressModal.tsx - ESP3D WebUI component file

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
import { Info } from "preact-feather"
import { useUiContextFn } from "../../contexts"
import type { ModalInstanceId } from "../../contexts/ModalsContext"
import type { ShowProgressModalParams } from "../../types/modals.types"

const showProgressModal = ({
    modals,
    title,
    button1,
    content,
}: ShowProgressModalParams): ModalInstanceId | undefined => {
    const id = "progression"
    let instanceId: ModalInstanceId | undefined
    const defaultCb1 = () => {
        useUiContextFn.haptic()
        if (instanceId) modals.removeModalByInstanceId(instanceId)
        if (button1 && button1.cb) button1.cb()
    }

    instanceId = modals.addModal({
        id,
        title: (
            <div class="text-primary feather-icon-container modal_title">
                <Info />
                <label>{title}</label>
            </div>
        ),
        content,
        footer: (
            <button class="btn mx-2" onClick={defaultCb1}>
                {button1.text}
            </button>
        ),
        //overlay: true,
        hideclose: true,
    })
    return instanceId
}

export { showProgressModal }
export type { ShowProgressModalParams, ProgressButton } from "../../types/modals.types"
