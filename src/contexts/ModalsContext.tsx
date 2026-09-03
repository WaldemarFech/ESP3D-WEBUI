import { createContext, FunctionalComponent, ComponentChildren } from "preact"
import { useContext, useState, useCallback, useMemo, useRef } from "preact/hooks"
import { generateUID, disableUI } from "../components/Helpers"
import { createModalStore } from "./ModalStore"
import type { Modal, ModalInput, ModalInstanceId } from "./ModalStore"

interface ModalsContextValue {
    modals: {
        modalList: Modal[]
        addModal: (modal: ModalInput) => ModalInstanceId | undefined
        removeModal: (index: number) => void
        removeModalById: (id: string) => void
        removeModalByInstanceId: (instanceId: ModalInstanceId) => void
        getModalIndex: (id: string) => number
        clearModals: () => void
    }
}

interface ModalsContextProviderProps {
    children: ComponentChildren
}

const ModalsContext = createContext<ModalsContextValue | undefined>(undefined)
const useModalsContext = () => {
    const context = useContext(ModalsContext)
    if (!context) {
        throw new Error("useModalsContext must be used within a ModalsContextProvider")
    }
    return context
}

const ModalsContextProvider: FunctionalComponent<ModalsContextProviderProps> = ({ children }) => {
    const [modals, setModal] = useState<Modal[]>([])
    const storeRef = useRef<ReturnType<typeof createModalStore>>()
    if (!storeRef.current) storeRef.current = createModalStore(generateUID)
    const modalStore = storeRef.current

    const addModal = useCallback((newModal: ModalInput): ModalInstanceId | undefined => {
        const instanceId = modalStore.add(newModal)
        if (instanceId) setModal(modalStore.list())
        return instanceId
    }, [modalStore])

    const getModalIndex = useCallback(
        (id: string): number => {
            return modals.findIndex((element) => element.id == id)
        },
        [modals]
    )

    const removeModal = useCallback((modalIndex: number) => {
        const previousLength = modalStore.list().length
        modalStore.removeAt(modalIndex)
        const newModalList = modalStore.list()
        if (newModalList.length === previousLength) return
        setModal(newModalList)
        if (newModalList.length == 0) disableUI(false)
    }, [modalStore])

    const removeModalById = useCallback((id: string) => {
        if (!modalStore.removeById(id)) return
        const newModalList = modalStore.list()
        setModal(newModalList)
        if (newModalList.length == 0) disableUI(false)
    }, [modalStore])

    const removeModalByInstanceId = useCallback((instanceId: ModalInstanceId) => {
        if (!modalStore.removeByInstanceId(instanceId)) return
        const newModalList = modalStore.list()
        setModal(newModalList)
        if (newModalList.length == 0) disableUI(false)
    }, [modalStore])

    const clearModals = useCallback(() => {
        modalStore.clear()
        setModal([])
    }, [modalStore])

    const store: ModalsContextValue = useMemo(
        () => ({
            modals: {
                modalList: modals,
                addModal,
                removeModal,
                removeModalById,
                removeModalByInstanceId,
                getModalIndex,
                clearModals,
            },
        }),
        [modals, addModal, removeModal, removeModalById, removeModalByInstanceId, getModalIndex, clearModals]
    )

    return <ModalsContext.Provider value={store}>{children}</ModalsContext.Provider>
}

export { ModalsContextProvider, useModalsContext }
export type { ModalsContextValue, Modal, ModalInput, ModalInstanceId }
