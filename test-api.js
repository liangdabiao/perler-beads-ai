const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const path = require('path');

// 读取.env.local文件
const envPath = path.join(__dirname, '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envLines = envContent.split('\n');

for (const line of envLines) {
  const trimmedLine = line.trim();
  if (!trimmedLine || trimmedLine.startsWith('#')) continue;

  const equalIndex = trimmedLine.indexOf('=');
  if (equalIndex > 0) {
    const key = trimmedLine.substring(0, equalIndex).trim();
    const value = trimmedLine.substring(equalIndex + 1).trim();
    process.env[key] = value;
  }
}

// 火山引擎API配置
const VOLC_API_HOST = 'visual.volcengineapi.com';
const VOLC_API_REGION = 'cn-north-1';
const VOLC_API_SERVICE = 'cv';

// 从环境变量获取API密钥
const accessKeyId = process.env.VOLC_ACCESS_KEY_ID;
let secretAccessKey = process.env.VOLC_SECRET_ACCESS_KEY;

if (!accessKeyId || !secretAccessKey) {
  console.error('Missing VOLC_ACCESS_KEY_ID or VOLC_SECRET_ACCESS_KEY environment variables');
  process.exit(1);
}

console.log('Raw Access Key ID:', accessKeyId);

// 直接使用Secret Key（不需要解码，因为.env.local中的值已经是解码后的）
console.log('Secret Key (raw):', secretAccessKey);
console.log('Secret Key length:', secretAccessKey.length);

// 火山引擎官方签名函数
function hmac(secret, s) {
  return crypto.createHmac('sha256', secret).update(s, 'utf8').digest();
}

function hash(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function uriEscape(str) {
  try {
    return encodeURIComponent(str)
      .replace(/[^A-Za-z0-9_.~\-%]+/g, escape)
      .replace(/[*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch (e) {
    return '';
  }
}

function queryParamsToString(params) {
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
      if (Array.isArray(val)) {
        return `${escapedKey}=${val.map(uriEscape).sort().join(`&${escapedKey}=`)}`;
      }
      return `${escapedKey}=${uriEscape(val)}`;
    })
    .filter((v) => v)
    .join('&');
}

const HEADER_KEYS_TO_IGNORE = new Set([
  'authorization',
  'content-length',
  'content-type',
  'user-agent',
]);

function getSignHeaders(originHeaders, needSignHeaders) {
  function trimHeaderValue(header) {
    return header.toString?.().trim().replace(/\s+/g, ' ') ?? '';
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

function sign(params) {
  const {
    headers = {},
    query = {},
    region = '',
    serviceName = '',
    method = '',
    pathName = '/',
    accessKeyId = '',
    secretAccessKey = '',
    needSignHeaderKeys = [],
    bodySha,
  } = params;
  const datetime = headers["X-Date"] || headers["x-date"];
  const date = datetime.substring(0, 8);

  const [signedHeaders, canonicalHeaders] = getSignHeaders(headers, needSignHeaderKeys);
  const canonicalRequest = [
    method.toUpperCase(),
    pathName,
    queryParamsToString(query) || '',
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodySha || hash(''),
  ].join('\n');

  const credentialScope = [date, region, serviceName, "request"].join('/');
  const stringToSign = ["HMAC-SHA256", datetime, credentialScope, hash(canonicalRequest)].join('\n');

  // 调试信息
  console.log('\n========== DEBUG INFO ==========');
  console.log('Canonical Request:');
  console.log(canonicalRequest);
  console.log('\nString to Sign:');
  console.log(stringToSign);
  console.log('\nSecret Key (first 10 chars):', secretAccessKey.substring(0, 10) + '...');
  console.log('================================\n');

  const kDate = hmac(secretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, serviceName);
  const kSigning = hmac(kService, "request");
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return [
    "HMAC-SHA256",
    `Credential=${accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(' ');
}

function getDateTimeNow() {
  const now = new Date();
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

// 读取本地图片并转为base64
const imagePath = path.join(__dirname, 'generated-34df74d1-fab4-4dbd-9662-4f6b8d6f1b93.jpg');
console.log('\nReading image from:', imagePath);

const imageBuffer = fs.readFileSync(imagePath);
const imageBase64 = imageBuffer.toString('base64');
console.log('Image size:', imageBuffer.length, 'bytes');
console.log('Base64 length:', imageBase64.length);

// 构建请求体 - 使用binary_data_base64参数
const requestBody = {
  req_key: 'jimeng_t2i_v40',
  binary_data_base64: [imageBase64],
  prompt: '图片修改为：pixel art style, 16-bit, retro game aesthetic, sharp focus, high contrast, clean lines, detailed pixel art, masterpiece, best quality',
  scale: 0.5,
  force_single: true,
};

// 使用JSON.stringify
const body = JSON.stringify(requestBody);
console.log('Request body length:', body.length);

// 计算SHA256
const bodySha = hash(body);
console.log('Body SHA256:', bodySha);

// 构建查询参数
const query = {
  Action: 'CVSync2AsyncSubmitTask',
  Version: '2022-08-31'
};

// 获取当前时间
const xDate = getDateTimeNow();
console.log('X-Date:', xDate);

// 构建headers
const headers = {
  'host': VOLC_API_HOST,
  'X-Date': xDate,
  'content-type': 'application/json'
};

// 生成签名
const authorization = sign({
  headers,
  query,
  region: VOLC_API_REGION,
  serviceName: VOLC_API_SERVICE,
  method: 'POST',
  pathName: '/',
  accessKeyId,
  secretAccessKey,
  bodySha
});

console.log('Authorization:', authorization.substring(0, 100) + '...');

// 使用https模块发送请求
async function submitTask() {
  return new Promise((resolve, reject) => {
    console.log('\nSending request...');
    const queryString = queryParamsToString(query);
    console.log('Query string:', queryString);

    const options = {
      hostname: VOLC_API_HOST,
      port: 443,
      path: `/?${queryString}`,
      method: 'POST',
      headers: {
        ...headers,
        'Authorization': authorization,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    console.log('Request options:', JSON.stringify(options, null, 2));

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('\nResponse status:', res.statusCode);
        console.log('Response body:', data);

        if (res.statusCode === 200) {
          const result = JSON.parse(data);
          console.log('\n✓ Success! Task ID:', result.data?.task_id);
          resolve(result);
        } else {
          reject(new Error(`Request failed with status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('Request error:', error);
      reject(error);
    });

    // 写入body
    req.write(body);
    req.end();
  });
}

// 查询任务结果
async function queryTask(taskId) {
  return new Promise((resolve, reject) => {
    console.log('\nQuerying task:', taskId);

    const queryRequestBody = {
      req_key: 'jimeng_t2i_v40',
      task_id: taskId
    };

    const queryBody = JSON.stringify(queryRequestBody);
    const queryBodySha = hash(queryBody);

    const queryQuery = {
      Action: 'CVSync2AsyncGetResult',
      Version: '2022-08-31'
    };

    const queryXDate = getDateTimeNow();

    const queryHeaders = {
      'host': VOLC_API_HOST,
      'X-Date': queryXDate,
      'content-type': 'application/json'
    };

    const queryAuthorization = sign({
      headers: queryHeaders,
      query: queryQuery,
      region: VOLC_API_REGION,
      serviceName: VOLC_API_SERVICE,
      method: 'POST',
      pathName: '/',
      accessKeyId,
      secretAccessKey,
      bodySha: queryBodySha
    });

    const options = {
      hostname: VOLC_API_HOST,
      port: 443,
      path: `/?${queryParamsToString(queryQuery)}`,
      method: 'POST',
      headers: {
        ...queryHeaders,
        'Authorization': queryAuthorization,
        'Content-Length': Buffer.byteLength(queryBody)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('Response status:', res.statusCode);
        console.log('Response body:', data);

        if (res.statusCode === 200) {
          const result = JSON.parse(data);
          resolve(result);
        } else {
          reject(new Error(`Query failed with status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(queryBody);
    req.end();
  });
}

// 轮询等待任务完成
async function pollTask(taskId) {
  for (let i = 0; i < 60; i++) {
    console.log(`\nPolling attempt ${i + 1}...`);
    const result = await queryTask(taskId);
    
    console.log('Status:', result.data?.status);

    if (result.data?.status === 'done') {
      console.log('\n✓ Task completed!');
      console.log('Image URLs:', result.data?.image_urls);

      if (result.data?.image_urls && result.data.image_urls.length > 0) {
        await downloadImage(result.data.image_urls[0]);
      } else if (result.data?.binary_data_base64 && result.data.binary_data_base64.length > 0) {
        // 处理base64图片数据
        console.log('Saving image from base64 data...');
        const base64Data = result.data.binary_data_base64[0];
        const buffer = Buffer.from(base64Data, 'base64');
        const outputPath = path.join(__dirname, 'ai-optimized-result.jpg');
        fs.writeFileSync(outputPath, buffer);
        console.log('✓ Image saved to:', outputPath);
      }
      return result;
    } else if (result.data?.status === 'failed') {
      console.error('✗ Task failed:', result.data?.message);
      return result;
    }

    // 等待3秒
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

async function downloadImage(imageUrl) {
  console.log('\nDownloading image from:', imageUrl);

  return new Promise((resolve, reject) => {
    https.get(imageUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to get image, status code: ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const outputPath = path.join(__dirname, 'ai-optimized-result.jpg');
        fs.writeFileSync(outputPath, buffer);
        console.log('✓ Image saved to:', outputPath);
        resolve(outputPath);
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

// 主函数
async function main() {
  try {
    const result = await submitTask();
    console.log('Full result:', JSON.stringify(result, null, 2));

    if (result.data?.task_id) {
      await pollTask(result.data.task_id);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
