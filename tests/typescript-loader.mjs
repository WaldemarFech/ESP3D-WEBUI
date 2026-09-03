import ts from "typescript"
import vm from "node:vm"
import { readFile } from "node:fs/promises"

const cache = new Map()

function resolveSpecifier(specifier, referrer) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return specifier
    const resolved = new URL(specifier, referrer)
    if (!/\.[cm]?[jt]sx?$/.test(resolved.pathname)) resolved.pathname += ".ts"
    return resolved.href
}

async function loadModule(url) {
    if (cache.has(url)) return cache.get(url)
    if (!url.startsWith("file:")) {
        const namespace = await import(url)
        const names = Object.keys(namespace)
        const module = new vm.SyntheticModule(names, function () {
            for (const name of names) this.setExport(name, namespace[name])
        }, { identifier: url })
        cache.set(url, module)
        await module.link(() => {})
        await module.evaluate()
        return module
    }

    const source = await readFile(new URL(url), "utf8")
    const output = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2021,
            module: ts.ModuleKind.ES2022,
            isolatedModules: true,
        },
        fileName: new URL(url).pathname,
    }).outputText
    const module = new vm.SourceTextModule(output, {
        identifier: url,
        initializeImportMeta(meta) { meta.url = url },
        importModuleDynamically(specifier, referencingModule) {
            return loadModule(resolveSpecifier(specifier, referencingModule.identifier))
        },
    })
    cache.set(url, module)
    await module.link((specifier, referencingModule) => loadModule(resolveSpecifier(specifier, referencingModule.identifier)))
    await module.evaluate()
    return module
}

export async function importTypeScript(path) {
    const url = new URL(path, import.meta.url).href
    return (await loadModule(url)).namespace
}
