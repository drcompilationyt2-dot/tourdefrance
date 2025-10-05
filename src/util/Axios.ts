import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { AccountProxy } from '../interface/Account'

type AgentPair = { httpAgent: any; httpsAgent: any }

class AxiosClient {
    private instance: AxiosInstance
    private account: AccountProxy

    constructor(account: AccountProxy) {
        this.account = account
        this.instance = axios.create()

        // when using custom agents, disable axios built-in proxy handling
        // otherwise axios's proxy config may conflict with the agent (and sometimes expects username/password).
        this.instance.defaults.proxy = false

        // If a proxy configuration is provided, set up the agents
        if (this.account.url && this.account.proxyAxios) {
            const agents = this.getAgentForProxy(this.account)
            // assign both - axios will use httpAgent for http requests and httpsAgent for https requests
            this.instance.defaults.httpAgent = agents.httpAgent
            this.instance.defaults.httpsAgent = agents.httpsAgent
        }
    }

    // returns an object with httpAgent and httpsAgent (use `any` since agent types differ)
    private getAgentForProxy(proxyConfig: AccountProxy): AgentPair {
        let { url, port, username, password } = proxyConfig

        // ensure url is a string
        url = String(url || '')

        // If user provided only host/IP without scheme, assume HTTPS (so we tunnel TLS).
        // This follows your request: "if there is just ip add the https"
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
            url = `https://${url}`
        }

        // Normalize via URL
        const parsed = new URL(url)

        // If port is explicitly provided separately, overwrite/assign it
        if (port) parsed.port = String(port)

        // inject auth if provided using URL fields (safer than manual string concat)
        if (username && username.length) {
            parsed.username = username
            parsed.password = password || ''
        }

        // Use the normalized proxy URL (toString keeps scheme, host, port, and creds)
        const proxyUrl = parsed.toString() // e.g. "https://user:pass@151.145.36.194:3128/"

        // Prepare agent pair
        let httpAgent: any = undefined
        let httpsAgent: any = undefined

        // Choose behavior by proxy scheme:
        // - http proxy: use HttpProxyAgent for http targets, HttpsProxyAgent for https targets (CONNECT)
        // - https proxy: use HttpsProxyAgent for both targets
        // - socks*: use SocksProxyAgent for both
        if (parsed.protocol === 'http:') {
            httpAgent = new HttpProxyAgent(proxyUrl)
            httpsAgent = new HttpsProxyAgent(proxyUrl)
        } else if (parsed.protocol === 'https:') {
            // https proxy (rare) — use HttpsProxyAgent for both
            httpAgent = new HttpsProxyAgent(proxyUrl)
            httpsAgent = new HttpsProxyAgent(proxyUrl)
        } else if (parsed.protocol.startsWith('socks')) {
            const sa = new SocksProxyAgent(proxyUrl)
            httpAgent = sa
            httpsAgent = sa
        } else {
            throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`)
        }

        return { httpAgent, httpsAgent }
    }

    public async request(config: AxiosRequestConfig, bypassProxy = false): Promise<AxiosResponse> {
        if (bypassProxy) {
            const bypassInstance = axios.create()
            bypassInstance.defaults.proxy = false
            return bypassInstance.request(config)
        }

        try {
            return await this.instance.request(config)
        } catch (err: unknown) {
            const e = err as { code?: string; cause?: { code?: string }; message?: string } | undefined
            const code = e?.code || e?.cause?.code
            const isNetErr =
                code === 'ECONNREFUSED' ||
                code === 'ETIMEDOUT' ||
                code === 'ECONNRESET' ||
                code === 'ENOTFOUND'
            const msg = String(e?.message || '')
            const looksLikeProxyIssue = /proxy|tunnel|socks|agent|502|504/i.test(msg)

            // If it looks like a proxy/network issue and we haven't bypassed yet, retry without proxy
            if (!bypassProxy && (isNetErr || looksLikeProxyIssue)) {
                const bypassInstance = axios.create()
                bypassInstance.defaults.proxy = false
                return bypassInstance.request(config)
            }
            throw err
        }
    }
}

export default AxiosClient
