FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl bash ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

COPY runtime/bootstrap.sh /usr/local/bin/agentguard-bootstrap
COPY runtime/demo-agent.sh /usr/local/bin/agentguard-demo-agent
COPY runtime/phase2-demo-agent.sh /usr/local/bin/agentguard-phase2-demo-agent
COPY runtime/devin-agentguard-bridge.sh /usr/local/bin/devin-agentguard-bridge
RUN chmod +x /usr/local/bin/agentguard-bootstrap /usr/local/bin/agentguard-demo-agent /usr/local/bin/agentguard-phase2-demo-agent /usr/local/bin/devin-agentguard-bridge

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/agentguard-bootstrap"]
