// completions.js

const axios = require('axios');

const DEFAULT_SYSTEM_CONTENT = `
# CONTEXT #
你是一位资深的内容安全审核专家,拥有丰富的内容审核经验,需要严格按照平台内容安全规范进行专业审核。你需要以严谨的态度对所有内容进行安全合规把关,重点识别和判断以下违规内容:
- 色情和暴露内容(包括但不限于裸露、性暗示等)
- 恐怖暴力内容(包括但不限于血腥、暴力等)
- 违法违规内容(包括但不限于毒品、赌博、诈骗等)
- 其他可能违反法律法规的内容

# OBJECTIVE #
作为专业的内容安全审核员,你需要:
1. 对提交的所有文本进行严格的安全合规审查
2. 基于内容安全审核标准进行多维度违规识别
3. 输出准确的布尔类型审核结果

# STYLE #
- 专业的审核视角
- 严格的审核标准  
- 规范的输出格式

# TONE #
- 严肃专业
- 客观公正
- 不带感情色彩

# RESPONSE #
必须按照以下JSON格式严格输出审核结果:
{
    "isViolation": false,  // 若检测到任何违规内容则返回true,否则返回false
}

任何非JSON格式的额外说明都不允许输出。
必须只有一个参数，且参数名为"isViolation"，且值为布尔类型。
`;


function preprocessMessages(messages) {
  return messages.map(message => {
    if (Array.isArray(message.content)) {
      // 从数组内容中提取所有文本
      const textContent = message.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n');

      return {
        role: message.role,
        content: textContent || '' // 如果没有文本则返回空字符串
      };
    }

    // 处理字符串内容
    if (typeof message.content === 'string') {
      if (message.content.startsWith('{') || message.content.startsWith('[')) {
        try {
          const parsedContent = JSON.parse(message.content);
          return {
            role: message.role,
            content: JSON.stringify(parsedContent, null, 2)
          };
        } catch (e) {
          return message;
        }
      }
      return message;
    }

    return message;
  });
}

// 处理错误并返回格式化后的错误信息
function handleError(error) {
  console.error('Error:', error.message);

  // 优先处理服务商返回的错误结构
  if (error.response?.data) {
    const providerError = error.response.data.error || error.response.data;
    return {
      error: {
        message: providerError.message || error.message,
        type: providerError.type || "api_error",
        code: providerError.code || error.response.status,
        param: providerError.param,
        // 保留原始错误信息用于调试
        provider_details: error.response.data 
      }
    };
  }

  // 保留特定自定义错误类型
  const preservedCodes = ['invalid_auth_key', 'content_violation'];
  if (preservedCodes.includes(error.code)) {
    return {
      error: {
        message: error.message,
        type: error.type || "invalid_request_error",
        code: error.code
      }
    };
  }

  // 处理网络连接类错误
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
    return {
      error: {
        message: "服务暂时不可用，请稍后重试",
        type: "connection_error",
        code: 503
      }
    };
  }

  // 通用错误格式
  return {
    error: {
      message: error.message || '服务器内部错误',
      type: "internal_error",
      code: error.status || 500
    }
  };
}

// 发送到第二个运营商的请求处理
async function sendToSecondProvider(req, secondProviderUrl, secondProviderConfig) {
  // 构造基础请求
  const secondProviderRequest = {
    model: req.body.model,
    messages: req.body.messages,
    stream: req.body.stream || false,
    temperature: req.body.temperature,
    max_tokens: req.body.max_tokens || 2000
  };

  // 可选参数按需添加
  if (req.body.response_format) {
    secondProviderRequest.response_format = req.body.response_format;
  }

  if (req.body.tools) {
    secondProviderRequest.tools = req.body.tools;
  }

  console.log('Second provider request:', {
    ...secondProviderRequest,
    messages: secondProviderRequest.messages.map(msg => ({
      ...msg,
      content: Array.isArray(msg.content)
        ? 'Array content (not displayed)'
        : msg.content
    }))
  });

  if (req.body.stream) {
    return await axios.post(
      secondProviderUrl + '/v1/chat/completions',
      secondProviderRequest,
      {
        ...secondProviderConfig,
        responseType: 'stream'
      }
    );
  }

  return await axios.post(
    secondProviderUrl + '/v1/chat/completions',
    secondProviderRequest,
    secondProviderConfig
  );
}

// 处理流式响应的函数
async function handleStream(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // 提取文本消息进行审核
    const textMessages = preprocessMessages(req.body.messages);

    // 构建审核消息
    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...textMessages, // 保留所有原始消息
      { role: "user", content: "请根据上述审核规范对全部消息内容进行安全审查" }
    ];

    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 45000
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 60000
    };

    // 创建审核请求
    const moderationRequest = {
      messages: moderationMessages,
      model: firstProviderModel,
      temperature: 0,
      max_tokens: 100,
      // 强制审核模型使用 json_object 格式输出
      response_format: {
        type: "json_object"
      }
    };

    console.log('Moderation Request:', moderationRequest);

    const checkResponse = await axios.post(
      firstProviderUrl + '/v1/chat/completions',
      moderationRequest,
      firstProviderConfig
    );

    try {
      const moderationResult = JSON.parse(checkResponse.data.choices[0].message.content);
      if (moderationResult.isViolation === true) {
        res.write(`data: ${JSON.stringify({
          error: {
            message: "Content violation detected",
            type: "content_filter_error",
            code: "content_violation"
          }
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    } catch (parseError) {
      console.error('Moderation parsing error:', parseError.message);
      throw new Error('Invalid moderation response format');
    }

    // 如果审核通过，发送到第二个运营商
    const response = await sendToSecondProvider(req, secondProviderUrl, secondProviderConfig);
    response.data.pipe(res);

  } catch (error) {
    console.error('Stream handler error:', error.message);
    const errorResponse = handleError(error);
    try {
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch (writeError) {
      console.error('Error writing error response:', writeError.message);
    }
    res.end();
  }
}

// 处理非流式响应的函数
async function handleNormal(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  try {
    const textMessages = preprocessMessages(req.body.messages);

    // 构建审核消息
    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...textMessages, // 保留所有原始消息
      { role: "user", content: "请根据上述审核规范对全部消息内容进行安全审查" }
    ];

    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 45000
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 60000
    };

    const moderationRequest = {
      messages: moderationMessages,
      model: firstProviderModel,
      temperature: 0,
      max_tokens: 100,
      // 强制审核模型使用 json_object 格式输出
      response_format: {
        type: "json_object"
      }
    };

    console.log('Moderation Request:', moderationRequest);

    const checkResponse = await axios.post(
      firstProviderUrl + '/v1/chat/completions',
      moderationRequest,
      firstProviderConfig
    );

    try {
      const moderationResult = JSON.parse(checkResponse.data.choices[0].message.content);
      if (moderationResult.isViolation === true) {
        return res.status(403).json({
          error: {
            message: "Content violation detected",
            type: "content_filter_error",
            code: "content_violation"
          }
        });
      }
    } catch (parseError) {
      console.error('Moderation parsing error:', parseError.message);
      throw new Error('Invalid moderation response format');
    }

    const response = await sendToSecondProvider(req, secondProviderUrl, secondProviderConfig);
    res.json(response.data);

  } catch (error) {
    console.error('Normal handler error:', error.message);
    const errorResponse = handleError(error);
    try {
      res.status(errorResponse.error.code || 500).json(errorResponse);
    } catch (writeError) {
      console.error('Error sending error response:', writeError.message);
      res.status(500).json({
        error: {
          message: "Internal server error",
          type: "internal_error",
          code: 500
        }
      });
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: {
        message: "Method not allowed",
        type: "invalid_request_error",
        code: 405
      }
    });
  }

  const authKey = req.headers.authorization?.replace('Bearer ', '');
  const validAuthKey = process.env.AUTH_KEY;

  if (!authKey || authKey !== validAuthKey) {
    return res.status(401).json({
      error: {
        message: "Invalid authentication key",
        type: "invalid_request_error",
        code: "invalid_auth_key"
      }
    });
  }

  const firstProviderUrl = process.env.FIRST_PROVIDER_URL;
  const secondProviderUrl = process.env.SECOND_PROVIDER_URL;
  const firstProviderModel = process.env.FIRST_PROVIDER_MODEL;
  const firstProviderKey = process.env.FIRST_PROVIDER_KEY;
  const secondProviderKey = process.env.SECOND_PROVIDER_KEY;

  try {
    if (req.body.stream) {
      await handleStream(
        req,
        res,
        firstProviderUrl,
        secondProviderUrl,
        firstProviderModel,
        firstProviderKey,
        secondProviderKey
      );
    } else {
      await handleNormal(
        req,
        res,
        firstProviderUrl,
        secondProviderUrl,
        firstProviderModel,
        firstProviderKey,
        secondProviderKey
      );
    }
  } catch (error) {
    console.error('Request handler error:', error.message);
    const errorResponse = handleError(error);
    if (req.body.stream) {
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(errorResponse.error.code || 500).json(errorResponse);
    }
  }
};
