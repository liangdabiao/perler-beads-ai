import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// 火山引擎API配置
const VOLC_API_HOST = 'visual.volcengineapi.com';
const VOLC_API_REGION = 'cn-north-1';
const VOLC_API_SERVICE = 'cv';

// 从环境变量获取API密钥
const getApiKeys = () => {
  const accessKeyId = process.env.VOLC_ACCESS_KEY_ID;
  const secretAccessKey = process.env.VOLC_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing VOLC_ACCESS_KEY_ID or VOLC_SECRET_ACCESS_KEY environment variables');
  }

  return { accessKeyId, secretAccessKey };
};

// 需要忽略的headers
const HEADER_KEYS_TO_IGNORE = new Set([
  'authorization',
  'content-length',
  'content-type',
  'user-agent',
]);

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

// HMAC-SHA256
function hmac(secret: string | Buffer, s: string): Buffer {
  return crypto.createHmac('sha256', secret).update(s, 'utf8').digest();
}

// SHA256哈希
function hash(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// 生成火山引擎签名
function generateSignature(
  method: string,
  pathName: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  bodySha: string,
  accessKeyId: string,
  secretAccessKey: string
): string {
  const datetime = headers['X-Date'] || headers['x-date'];
  const date = datetime.substring(0, 8);

  const [signedHeaders, canonicalHeaders] = getSignHeaders(headers);
  const canonicalRequest = [
    method.toUpperCase(),
    pathName,
    queryParamsToString(query) || '',
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodySha || hash(''),
  ].join('\n');

  const credentialScope = [date, VOLC_API_REGION, VOLC_API_SERVICE, 'request'].join('/');
  const stringToSign = ['HMAC-SHA256', datetime, credentialScope, hash(canonicalRequest)].join('\n');

  const kDate = hmac(secretAccessKey, date);
  const kRegion = hmac(kDate, VOLC_API_REGION);
  const kService = hmac(kRegion, VOLC_API_SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

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
async function submitTask(imageBase64: string, prompt: string) {
  const { accessKeyId, secretAccessKey } = getApiKeys();

  // 提取纯base64数据（去掉data:image/png;base64,前缀）
  const base64Data = imageBase64.includes(',')
    ? imageBase64.split(',')[1]
    : imageBase64;

  // 构建请求体 - 使用binary_data_base64字段直接上传图片
  const requestBody = {
    req_key: 'jimeng_t2i_v40',
    binary_data_base64: [base64Data],
    prompt: prompt,
    scale: 0.5,
    force_single: true,
  };

  const body = JSON.stringify(requestBody);
  const bodySha = hash(body);

  // 构建查询参数
  const query = {
    Action: 'CVSync2AsyncSubmitTask',
    Version: '2022-08-31'
  };

  // 获取当前时间
  const xDate = getDateTimeNow();

  // 构建headers
  const headers: Record<string, string> = {
    'host': VOLC_API_HOST,
    'X-Date': xDate,
    'content-type': 'application/json'
  };

  // 生成签名
  const authorization = generateSignature(
    'POST',
    '/',
    query,
    headers,
    bodySha,
    accessKeyId,
    secretAccessKey
  );

  // 发送请求
  const queryString = queryParamsToString(query);
  const response = await fetch(`https://${VOLC_API_HOST}/?${queryString}`, {
    method: 'POST',
    headers: {
      ...headers,
      'Authorization': authorization,
      'Content-Length': Buffer.byteLength(body).toString()
    },
    body: body
  });

  const responseText = await response.text();
  console.log('Submit API Response:', response.status, responseText);

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${responseText}`);
  }

  const data = JSON.parse(responseText);
  return data;
}

// 查询任务结果
async function queryTask(taskId: string) {
  const { accessKeyId, secretAccessKey } = getApiKeys();

  // 构建请求体 - 需要包含req_key
  const requestBody = {
    req_key: 'jimeng_t2i_v40',
    task_id: taskId
  };

  const body = JSON.stringify(requestBody);
  const bodySha = hash(body);

  // 构建查询参数 - 使用CVSync2AsyncGetResult
  const query = {
    Action: 'CVSync2AsyncGetResult',
    Version: '2022-08-31'
  };

  // 获取当前时间
  const xDate = getDateTimeNow();

  // 构建headers
  const headers: Record<string, string> = {
    'host': VOLC_API_HOST,
    'X-Date': xDate,
    'content-type': 'application/json'
  };

  // 生成签名
  const authorization = generateSignature(
    'POST',
    '/',
    query,
    headers,
    bodySha,
    accessKeyId,
    secretAccessKey
  );

  // 发送请求
  const queryString = queryParamsToString(query);
  const response = await fetch(`https://${VOLC_API_HOST}/?${queryString}`, {
    method: 'POST',
    headers: {
      ...headers,
      'Authorization': authorization,
      'Content-Length': Buffer.byteLength(body).toString()
    },
    body: body
  });

  const responseText = await response.text();
  console.log('Query API Response:', response.status, responseText);

  if (!response.ok) {
    throw new Error(`API query failed: ${response.status} ${responseText}`);
  }

  const data = JSON.parse(responseText);
  return data;
}

// 轮询等待任务完成
async function waitForTaskCompletion(taskId: string, maxAttempts = 60, intervalMs = 3000): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(`Polling attempt ${attempt + 1}/${maxAttempts}...`);
    const result = await queryTask(taskId);

    // 检查任务状态
    if (result.data && result.data.status === 'done') {
      // 任务完成，返回图片URL或处理base64数据
      if (result.data.image_urls && result.data.image_urls.length > 0) {
        return result.data.image_urls[0];
      } else if (result.data.binary_data_base64 && result.data.binary_data_base64.length > 0) {
        // 将base64数据转为data URL
        const base64Data = result.data.binary_data_base64[0];
        return `data:image/jpeg;base64,${base64Data}`;
      }
      throw new Error('Task completed but no image data returned');
    } else if (result.data && result.data.status === 'failed') {
      throw new Error(`Task failed: ${result.data.message || 'Unknown error'}`);
    }

    // 等待后重试
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Task timeout: exceeded maximum polling attempts');
}

export async function POST(request: NextRequest) {
  try {
    const { imageBase64, prompt } = await request.json();

    if (!imageBase64) {
      return NextResponse.json(
        { error: 'Missing imageBase64 parameter' },
        { status: 400 }
      );
    }

    if (!prompt) {
      return NextResponse.json(
        { error: 'Missing prompt parameter' },
        { status: 400 }
      );
    }

    // 1. 提交任务
    console.log('Submitting AI optimization task...');
    const submitResult = await submitTask(imageBase64, prompt);

    if (!submitResult.data || !submitResult.data.task_id) {
      return NextResponse.json(
        { error: 'Failed to submit task', details: submitResult },
        { status: 500 }
      );
    }

    const taskId = submitResult.data.task_id;
    console.log('Task submitted, ID:', taskId);

    // 2. 轮询等待任务完成
    const imageUrl = await waitForTaskCompletion(taskId);

    // 3. 返回结果
    return NextResponse.json({
      success: true,
      imageUrl: imageUrl,
      taskId: taskId
    });

  } catch (error) {
    console.error('AI optimization error:', error);
    return NextResponse.json(
      {
        error: 'AI optimization failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
