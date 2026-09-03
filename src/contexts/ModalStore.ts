import type { ComponentChildren } from "preact"

declare const modalInstanceIdBrand: unique symbol
export type ModalInstanceId = string & { readonly [modalInstanceIdBrand]: true }

export interface Modal {
    id: string
    instanceId: ModalInstanceId
    title?: ComponentChildren
    content?: ComponentChildren
    footer?: ComponentChildren
    overlay?: boolean
    hideclose?: boolean
    [key: string]: any
}

export type ModalInput = Omit<Modal, "id" | "instanceId"> & { id?: string }

export interface ModalStore {
    add: (modal: ModalInput) => ModalInstanceId | undefined
    clear: () => void
    list: () => Modal[]
    removeAt: (index: number) => boolean
    removeById: (id: string) => boolean
    removeByInstanceId: (instanceId: ModalInstanceId) => boolean
}

const createModalStore = (generateId: () => string): ModalStore => {
    let modals: Modal[] = []

    const removeWhere = (matches: (modal: Modal, index: number) => boolean): boolean => {
        const modalIndex = modals.findIndex(matches)
        if (modalIndex === -1) return false
        modals = modals.filter((_modal, index) => index !== modalIndex)
        return true
    }

    return {
        add: (modal) => {
            const id = modal.id || generateId()
            if (modals.some((existing) => existing.id === id)) return undefined

            const instanceId = generateId() as ModalInstanceId
            modals = [...modals, { ...modal, id, instanceId }]
            return instanceId
        },
        clear: () => {
            modals = []
        },
        list: () => modals,
        removeAt: (index) => removeWhere((_modal, modalIndex) => modalIndex === index),
        removeById: (id) => removeWhere((modal) => modal.id === id),
        removeByInstanceId: (instanceId) =>
            removeWhere((modal) => modal.instanceId === instanceId),
    }
}

export { createModalStore }
