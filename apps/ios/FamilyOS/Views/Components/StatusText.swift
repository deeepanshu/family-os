import SwiftUI

struct StatusText: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        Text(viewModel.statusMessage)
            .font(.footnote)
            .foregroundStyle(viewModel.isError ? .red : .secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
