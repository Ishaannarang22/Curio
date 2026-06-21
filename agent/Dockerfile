FROM dailyco/pipecat-base:latest

# Enable bytecode compilation; copy (not link) from the mounted uv cache.
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy

# Install dependencies from the lockfile (no project install, no dev group).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Copy the whole agent package — bot.py imports the sibling modules
# (board_writer, board_tools, board_state, tuning, topic_*, *_agent).
COPY ./*.py ./
