# AgentCore Runtime requires linux/arm64 (built via DockerImageAsset platform LINUX_ARM64 in cdk/lib/stack.ts).
FROM --platform=linux/arm64 python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py .
# AgentCore Runtime proxies A2A containers on port 9000 at the root path.
ENV PORT=9000
EXPOSE 9000
CMD ["python", "agent.py"]
