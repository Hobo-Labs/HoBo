export function createMockBoundaryRecorder() {
  const calls = [];

  return {
    call(boundaryId, interaction, payload) {
      const entry = {
        boundaryId,
        interaction,
        mocked: true,
        payload,
      };
      calls.push(entry);
      return entry;
    },
    calls,
  };
}

export function scenarioBoundaries(boundaryCatalog, boundaryIds) {
  return boundaryIds.map((id) => {
    const boundary = boundaryCatalog.find((candidate) => candidate.id === id);
    if (!boundary) {
      throw new Error(`Unknown mocked boundary: ${id}`);
    }
    return {
      id: boundary.id,
      boundary: boundary.boundary,
      mocked: boundary.mockedInSimulation,
      pactFile: boundary.pactFile,
    };
  });
}
