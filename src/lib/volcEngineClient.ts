// 火山引擎即梦 AI 客户端直接调用
// 用于静态部署场景，直接从浏览器调用火山引擎 API

const VOLC_API_HOST = 'visual.volcengineapi.com';
const VOLC_API_REGION = 'cn-north-1';
const VOLC_API_SERVICE = 'cv';

const encoder = new TextEncoder();

const HEADER_KEYS_TO_IGNORE = new Set([
  'authorization',
  'content-length',
  'content-type',
  'user-agent',
]);

function toHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return new Uint8Array(sig);
}

async function sha256(data: string): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return toHex(new Uint8Array(hashBuf));
}

function uriEscape(str: string): string {
  try {
    return encodeURIComponent(str)
      .replace(/[^A-Za-z0-9_.~\-%]+/g, (c) => c)
      .replace(/[*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return '';
  }
}

function queryParamsToString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const val = params[key];
      if (typeof val === 'undefined' || val === null) {
        return undefined;
      }
      const escapedKey = uriEscape(key);
      if (!escapedKey) {
        return undefined;
      }
      return `${escapedKey}=${uriEscape(val)}`;
    })
    .filter((v): v is string => v !== undefined)
    .join('&');
}

function getSignHeaders(originHeaders: Record<string, string>, needSignHeaders?: string[]): [string, string] {
  function trimHeaderValue(header: string): string {
    return header?.toString().trim().replace(/\s+/g, ' ') ?? '';
  }

  let h = Object.keys(originHeaders);
  if (Array.isArray(needSignHeaders)) {
    const needSignSet = new Set([...needSignHeaders, 'x-date', 'host'].map((k) => k.toLowerCase()));
    h = h.filter((k) => needSignSet.has(k.toLowerCase()));
  }
  h = h.filter((k) => !HEADER_KEYS_TO_IGNORE.has(k.toLowerCase()));
  const signedHeaderKeys = h
    .slice()
    .map((k) => k.toLowerCase())
    .sort()
    .join(';');
  const canonicalHeaders = h
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map((k) => `${k.toLowerCase()}:${trimHeaderValue(originHeaders[k])}`)
    .join('\n');
  return [signedHeaderKeys, canonicalHeaders];
}

async function generateSignature(
  method: string,
  pathName: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  bodySha: string,
  accessKeyId: string,
  secretAccessKey: string
): Promise<string> {
  const datetime = headers['X-Date'] || headers['x-date'];
  const date = datetime.substring(0, 8);

  const [signedHeaders, canonicalHeaders] = getSignHeaders(headers);
  const emptyBodyHash = await sha256('');
  const canonicalRequest = [
    method.toUpperCase(),
    pathName,
    queryParamsToString(query) || '',
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodySha || emptyBodyHash,
  ].join('\n');

  const credentialScope = [date, VOLC_API_REGION, VOLC_API_SERVICE, 'request'].join('/');
  const canonicalRequestHash = await sha256(canonicalRequest);
  const stringToSign = ['HMAC-SHA256', datetime, credentialScope, canonicalRequestHash].join('\n');

  const secretKey = encoder.encode(secretAccessKey);
  const kDate = await hmac(secretKey, date);
  const kRegion = await hmac(kDate, VOLC_API_REGION);
  const kService = await hmac(kRegion, VOLC_API_SERVICE);
  const kSigning = await hmac(kService, 'request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  return [
    'HMAC-SHA256',
    `Credential=${accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(' ');
}

function getDateTimeNow(): string {
  const now = new Date();
  return now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
}

async function submitTask(imageBase64: string, prompt: string, accessKeyId: string, secretAccessKey: string) {
  const base64Data = imageBase64.includes(',')
    ? imageBase64.split(',')[1]
    : imageBase64;

  const requestBody = {
    req_key: 'jimeng_t2i_v40',
    binary_data_base64: [base64Data],
    prompt: prompt,
    scale: 0.5,
    force_single: true,
  };

  const body = JSON.stringify(requestBody);
  const bodySha = await sha256(body);

  const query = {
    Action: 'CVSync2AsyncSubmitTask',
    Version: '2022-08-31'
  };

  const xDate = getDateTimeNow();

  const headers: Record<string, string> = {
    'host': VOLC_API_HOST,
    'X-Date': xDate,
    'content-type': 'application/json'
  };

  const authorization = await generateSignature(
    'POST',
    '/',
    query,
    headers,
    bodySha,
    accessKeyId,
    secretAccessKey
  );

  const queryString = queryParamsToString(query);
  const response = await fetch(`https://${VOLC_API_HOST}/?${queryString}`, {
    method: 'POST',
    headers: {
      ...headers,
      'Authorization': authorization,
      'Content-Length': encoder.encode(body).length.toString()
    },
    body: body
  });

  const responseText = await response.text();

  if (!response.ok) {
    try {
      const errorData = JSON.parse(responseText);
      const errorCode = errorData.status || errorData.code;
      const errorMessage = errorData.message || '';

      if (errorCode === 50411 || errorMessage.includes('Risk')) {
        throw new Error(`IMAGE_RISK: 图片未能通过安全检测，请尝试使用其他图片。`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('IMAGE_RISK')) {
        throw err;
      }
    }
    throw new Error(`API request failed: ${response.status} ${responseText}`);
  }

  const data = JSON.parse(responseText);
  if (data.status && data.status !== 10000) {
    const errorCode = data.status;
    const errorMessage = data.message || '';

    if (errorCode === 50411 || errorMessage.includes('Risk')) {
      throw new Error(`IMAGE_RISK: 图片未能通过安全检测，请尝试使用其他图片。`);
    }
  }

  return data;
}

async function queryTask(taskId: string, accessKeyId: string, secretAccessKey: string) {
  const requestBody = {
    req_key: 'jimeng_t2i_v40',
    task_id: taskId
  };

  const body = JSON.stringify(requestBody);
  const bodySha = await sha256(body);

  const query = {
    Action: 'CVSync2AsyncGetResult',
    Version: '2022-08-31'
  };

  const xDate = getDateTimeNow();

  const headers: Record<string, string> = {
    'host': VOLC_API_HOST,
    'X-Date': xDate,
    'content-type': 'application/json'
  };

  const authorization = await generateSignature(
    'POST',
    '/',
    query,
    headers,
    bodySha,
    accessKeyId,
    secretAccessKey
  );

  const queryString = queryParamsToString(query);
  const response = await fetch(`https://${VOLC_API_HOST}/?${queryString}`, {
    method: 'POST',
    headers: {
      ...headers,
      'Authorization': authorization,
      'Content-Length': encoder.encode(body).length.toString()
    },
    body: body
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Query API request failed: ${response.status} ${responseText}`);
  }

  const data = JSON.parse(responseText);
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface VolcEngineResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

export async function callVolcEngineAI(
  imageBase64: string,
  prompt: string,
  accessKeyId: string,
  secretAccessKey: string,
  onProgress?: (progress: number) => void
): Promise<VolcEngineResult> {
  try {
    onProgress?.(10);

    const submitResult = await submitTask(imageBase64, prompt, accessKeyId, secretAccessKey);

    if (!submitResult.task_id) {
      return {
        success: false,
        error: 'Failed to submit task: no task_id returned'
      };
    }

    const taskId = submitResult.task_id;
    console.log('Task submitted, task_id:', taskId);

    const maxRetries = 60;
    const pollInterval = 3000;

    for (let i = 0; i < maxRetries; i++) {
      onProgress?.(30 + Math.floor((i / maxRetries) * 50));

      await sleep(pollInterval);

      const queryResult = await queryTask(taskId, accessKeyId, secretAccessKey);

      console.log('Query result:', JSON.stringify(queryResult));

      if (queryResult.status === 10000 && queryResult.data && queryResult.data.task_status === 'success') {
        const imageUrl = queryResult.data.images?.[0]?.url;

        if (imageUrl) {
          onProgress?.(100);
          return {
            success: true,
            imageUrl: imageUrl
          };
        }
      }

      if (queryResult.status !== 10000 || queryResult.data?.task_status === 'failed') {
        const errorMessage = queryResult.message || 'Task failed';
        throw new Error(errorMessage);
      }
    }

    return {
      success: false,
      error: 'Task timeout: max retries exceeded'
    };

  } catch (error) {
    console.error('VolcEngine AI error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
