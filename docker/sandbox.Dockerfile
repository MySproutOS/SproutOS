FROM daytonaio/sandbox:0.9.0

USER root

# The Daytona base supplies Node, Git and the toolbox services. Pin the coding harnesses and the
# package manager here so a new provider base cannot silently change how a customer turn behaves.
RUN npm install --global \
      pnpm@10.33.0 \
      @anthropic-ai/claude-code@2.1.246 \
      @openai/codex@0.150.0 \
    && npm cache clean --force

# This is Daytona's persistent path. Creating it in the image proves the user can write it before a
# clone spends a GitHub installation token and only then discovers the snapshot is unusable.
RUN install -d -o daytona -g daytona /home/daytona/workspace
RUN install -d -o daytona -g daytona /home/daytona/bin

ENV PATH="/home/daytona/bin:${PATH}"

USER daytona
WORKDIR /home/daytona/workspace
