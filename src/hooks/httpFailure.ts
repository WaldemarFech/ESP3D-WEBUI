import { getHttpFailureMessage } from "../types/http.types"
import type { HttpFailure } from "../types/http.types"
import type { ToastType } from "../contexts/ToastsContext"

interface ToastTarget {
    addToast: (toast: { content: string; type: ToastType }) => void
}

/** Render a transport failure as plain text so it is never treated as a translation key. */
export const addHttpFailureToast = (
    toasts: ToastTarget,
    error: HttpFailure | unknown,
    type: ToastType = "error"
): void => {
    toasts.addToast({ content: getHttpFailureMessage(error), type })
}

export { getHttpFailureMessage }
