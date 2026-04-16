interface Env {
  VOLC_ACCESS_KEY_ID: string;
  VOLC_SECRET_ACCESS_KEY: string;
}

// 火山引擎API配置
const VOLC_API_HOST = 'visual.volcengineapi.com';
const VOLC_API_REGION = 'cn-north-1';
const VOLC_API_SERVICE = 'cv';

const encoder = new TextEncoder();

// 需要忽略的headers
const HEADER_KEYS_TO_IGNORE = new Set([
  'authorization',
  'content-length',
  'content-type',
  'user-agent',
]);

// Uint8Array 转 hex 字符串
function toHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

// HMAC-SHA256 (Web Crypto API)
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

// SHA256 哈希 (Web Crypto API)
async function sha256(data: string): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return toHex(new Uint8Array(hashBuf));
}

// URI编码函数
function uriEscape(str: string): string {
  try {
    return encodeURIComponent(str)
      .replace(/[^A-Za-z0-9_.~\-%]+/g, (c) => c)
      .replace(/[*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch (e) {
    return '';
  }
}

// 查询参数转字符串
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

// 获取签名headers
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

// 生成火山引擎签名
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

// 获取当前时间（ISO格式，去掉分隔符）
function getDateTimeNow(): string {
  const now = new Date();
  return now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
}

// 提交任务到即梦AI
async function submitTask(imageBase64: string, prompt: string, env: Env) {
  const { VOLC_ACCESS_KEY_ID: accessKeyId, VOLC_SECRET_ACCESS_KEY: secretAccessKey } = env;

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
  console.log('Submit API Response:', response.status, responseText);

  if (!response.ok) {
    try {
      const errorData = JSON.parse(responseText);
      const errorCode = errorData.status || errorData.code;
      const errorMessage = errorData.message || '';

      if (errorCode === 50411 || errorMessage.includes('Risk')) {
        throw new Error(`IMAGE_RISK: 图片未能通过安全检测，请尝试使用其他图片。`);
      }
    } catch {
      // 解析失败，使用原始错误
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

// 查询任务结果
async function queryTask(taskId: string, env: Env) {
  const { VOLC_ACCESS_KEY_ID: accessKeyId, VOLC_SECRET_ACCESS_KEY: secretAccessKey } = env;

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
  console.log('Query API Response:', response.status, responseText);

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`API query failed: ${response.status} ${responseText}`);
  }

  if (!response.ok) {
    const errorCode = data.status || data.code;
    const errorMessage = data.message || '';

    if (errorCode === 50411 || errorMessage.includes('Risk')) {
      throw new Error(`IMAGE_RISK: 图片未能通过安全检测，请尝试使用其他图片。`);
    }

    throw new Error(`API query failed: ${response.status} ${responseText}`);
  }

  if (data.status && data.status !== 10000) {
    const errorCode = data.status;
    const errorMessage = data.message || '';

    if (errorCode === 50411 || errorMessage.includes('Risk')) {
      throw new Error(`IMAGE_RISK: 图片未能通过安全检测，请尝试使用其他图片。`);
    }
  }

  return data;
}

// 轮询等待任务完成
async function waitForTaskCompletion(taskId: string, env: Env, maxAttempts = 60, intervalMs = 3000): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(`Polling attempt ${attempt + 1}/${maxAttempts}...`);
    const result = await queryTask(taskId, env);

    if (result.data && result.data.status === 'done') {
      if (result.data.image_urls && result.data.image_urls.length > 0) {
        return result.data.image_urls[0];
      } else if (result.data.binary_data_base64 && result.data.binary_data_base64.length > 0) {
        const base64Data = result.data.binary_data_base64[0];
        return `data:image/jpeg;base64,${base64Data}`;
      }
      throw new Error('Task completed but no image data returned');
    } else if (result.data && result.data.status === 'failed') {
      const errorCode = result.status || result.code;
      const errorMessage = result.message || 'Unknown error';

      if (errorCode === 50411 || errorMessage.includes('Risk')) {
        throw new Error(`IMAGE_RISK: 图片未能通过安全检测，请尝试使用其他图片。`);
      }

      throw new Error(`Task failed: ${errorMessage}`);
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Task timeout: exceeded maximum polling attempts');
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { request, env } = context;
    const { imageBase64, prompt } = await request.json();

    if (!imageBase64) {
      return Response.json(
        { error: 'Missing imageBase64 parameter' },
        { status: 400 }
      );
    }

    if (!prompt) {
      return Response.json(
        { error: 'Missing prompt parameter' },
        { status: 400 }
      );
    }

    console.log('Submitting AI optimization task...');
    const submitResult = await submitTask(imageBase64, prompt, env);

    if (!submitResult.data || !submitResult.data.task_id) {
      return Response.json(
        { error: 'Failed to submit task', details: submitResult },
        { status: 500 }
      );
    }

    const taskId = submitResult.data.task_id;
    console.log('Task submitted, ID:', taskId);

    const imageUrl = await waitForTaskCompletion(taskId, env);

    return Response.json({
      success: true,
      imageUrl: imageUrl,
      taskId: taskId
    });

  } catch (error) {
    console.error('AI optimization error:', error);
    return Response.json(
      {
        error: 'AI optimization failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
};
