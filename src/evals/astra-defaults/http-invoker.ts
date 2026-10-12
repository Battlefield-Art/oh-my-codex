/**
 * Invoker using native Node.js HTTP/HTTPS for OpenAI-compatible APIs.
 * This provides support for custom base URLs without external dependencies.
 */

import { request } from 'node:https';
import type { CodexOutput } from './collector.js';

/**
 * Makes an HTTP request to an OpenAI-compatible API endpoint.
 */
function makeHTTPRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const reqHandler = request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 500,
            body: data,
          });
        });
      },
    );

    reqHandler.on('error', reject);

    if (body) {
      reqHandler.write(body);
    }

    reqHandler.end();
  });
}

/**
 * Invokes a model using the OpenAI chat completions API.
 * Simulates Codex exec behavior by making a chat completion request.
 */
export async function invokeViaHTTP(
  args: string[],
  _cwd: string,
  baseUrl: string = 'https://api.openai.com/v1',
): Promise<CodexOutput> {
  try {
    // Parse arguments
    let model = 'gpt-4';
    let prompt = '';
    
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-m' && i + 1 < args.length) {
        model = args[i + 1];
        i++;
      } else if (!args[i].startsWith('-') && args[i] !== 'exec' && args[i] !== '--json' && 
                 args[i] !== '--skip-git-repo-check' && args[i] !== '--ephemeral') {
        // Skip reasoning_effort and other -c config options
        if (!args[i].includes('reasoning_effort=') && !args[i].startsWith('-c')) {
          prompt = args[i];
        }
      }
    }
    
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: OPENAI_API_KEY environment variable is not set',
      };
    }
    
    // Build request
    const url = `${baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'omx-eval-harness',
    };

    const requestBody = JSON.stringify({
      model,
      messages: [
        { role: 'user', content: prompt },
      ],
      temperature: 1,
    });

    // Make the API request
    const response = await makeHTTPRequest('POST', url, headers, requestBody);

    if (response.status !== 200) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `API error: ${response.status} ${response.body}`,
      };
    }

    // Parse response
    let responseData: Record<string, unknown>;
    try {
      responseData = JSON.parse(response.body);
    } catch (e) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Failed to parse API response: ${response.body}`,
      };
    }

    // Format output as JSONL to match Codex exec format
    const choices = (responseData.choices as Array<{ message?: { content?: string } }>) || [];
    const message = choices[0]?.message?.content || '';
    const usage = responseData.usage as Record<string, number> | undefined;

    const jsonlOutput = [
      {
        type: 'message.start',
        message: {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
        },
      },
      {
        type: 'content_block.delta',
        delta: {
          type: 'text_delta',
          text: message,
        },
      },
      {
        type: 'message.stop',
        message: {
          id: `msg_${Date.now()}`,
          usage: {
            input_tokens: usage?.prompt_tokens || null,
            output_tokens: usage?.completion_tokens || null,
          },
        },
        response: message,
      },
    ];

    const stdout = jsonlOutput.map((obj) => JSON.stringify(obj)).join('\n');

    return {
      exitCode: 0,
      stdout,
      stderr: '',
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
