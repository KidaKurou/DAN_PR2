$(document).ready(function () {
  $(".delete-category").on("click", function () {
    var category_id = $(this).data("category-id");
    var elementToDelete = $(this).closest(".category-card");
    if (category_id) {
      $.ajax({
        type: "POST",
        url: "/delete_category",
        data: { category_id: category_id },
        success: function (response) {
          if (response.success) {
            elementToDelete.remove();
          } else {
            alert("Error: " + response.error);
          }
        },
        error: function (error) {
          console.error("AJAX Error:", error);
          console.error("AJAX Error:", error);
        },
      });
    } else {
      alert("Category ID is undefined.");
    }
  });
});
